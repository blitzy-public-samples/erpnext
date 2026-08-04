import { lazy, useEffect, useRef } from 'react'
import { useGetStatementDetails } from '@/components/features/BankStatementImporter/import_utils'
import {
    bankRecImportFailuresAtom,
    classifyImportAttempt,
    withImportAttempt,
    withoutImportAttempt
} from '@/components/features/BankReconciliation/bankRecAtoms'
import { isFrappeErrorEnvelope, toDisplayError } from '@/components/features/BankReconciliation/utils'
import { Button } from '@/components/ui/button'
import { useDirection } from '@/components/ui/direction'
import ErrorBanner from '@/components/ui/error-banner'
import _ from '@/lib/translate'
import { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import { useFrappeDocumentEventListener, useFrappeGetDoc } from 'frappe-react-sdk'
import { useSetAtom } from 'jotai'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Link, useParams } from 'react-router'

const CSVImport = lazy(() => import('@/components/features/BankStatementImporter/CSV/CSVImport'))
const PDFImport = lazy(() => import('@/components/features/BankStatementImporter/PDF/PDFImport'))

const ViewBankStatementImportLog = () => {

    const { id } = useParams<{ id: string }>()

    const { data, isLoading, error, mutate } = useGetStatementDetails(id ?? "")

    useFrappeDocumentEventListener("Bank Statement Import Log", id ?? "", () => {
    })

    const direction = useDirection()

    const setImportFailures = useSetAtom(bankRecImportFailuresAtom)

    /*
     * The RAW document, read only while `get_statement_details` is failing.
     *
     * That endpoint PARSES the file before it answers, so a malformed or empty statement makes it
     * throw and this page never receives a document - which means it knows neither the bank account
     * the log belongs to nor the status the log currently carries, and both are required to record an
     * attempt marker (the map is bank-scoped, and the classification refuses to call anything `failed`
     * without a server-provided status). Reading the document directly sidesteps the parse entirely:
     * `frappe.client.get` returns the stored fields, so it succeeds precisely when the parse does not.
     *
     * A `null` cache key disables the request, so nothing extra is fetched on the ordinary path where
     * the details response already carries the document. `revalidateOnFocus` is off to match the
     * details query beside it.
     */
    const { data: rawLog } = useFrappeGetDoc<BankStatementImportLog>(
        'Bank Statement Import Log',
        id,
        error && id ? undefined : null,
        { revalidateOnFocus: false }
    )

    /*
     * FM2's SECOND producer: a statement whose details the server REFUSED to produce.
     *
     * This is the failure mode's most literal case - a malformed or empty file - and it never reached
     * the importer list. `get_statement_details` throws while parsing, so the import step below never
     * mounts and its own marker-writing paths are unreachable; this page rendered the backend's error
     * and nothing else, and returning to the list showed an ordinary `Not Started` row with no
     * indication that the file cannot be read at all.
     *
     * Every input is the server's: `serverRejected` is true only for a genuine Frappe envelope (a
     * rejection carrying none is a statement about the connection, not about the server), and the
     * status comes from the raw document rather than being assumed. `classifyImportAttempt` then
     * decides, so this page cannot assert `failed` on its own - a lost response with no readable
     * document is recorded as `unknown`, which is the honest reading.
     *
     * ⚠️ THIS EFFECT OWNS EXACTLY ONE CONDITION: "the details were REFUSED". The statement-details
     * step below owns every LOADED case - it is the component that can see whether the parse produced
     * rows, so it records the zero-row failure and retires that `invalid` marker itself. Splitting
     * production that way is what keeps the two producers from fighting.
     */
    useEffect(() => {
        if (!error || !id || !rawLog?.bank_account) {
            return
        }

        const outcome = classifyImportAttempt({
            serverRejected: isFrappeErrorEnvelope(error),
            confirmedStatus: rawLog.status
        })

        if (outcome === 'completed') {
            return
        }

        setImportFailures((previousAttempts) =>
            withImportAttempt(previousAttempts, rawLog.bank_account, id, outcome))
    }, [error, id, rawLog?.bank_account, rawLog?.status, rawLog, setImportFailures])

    /*
     * ...and the RETIREMENT half of that same one condition: the details now LOAD, so whatever made
     * the server refuse them has been dealt with and this route's own marker has to go. A marker must
     * never outlive the condition it described, and this one otherwise could not be cleared at all -
     * `Bank Statement Import Log` has no error field and stays at `Not Started` forever, so a row
     * would keep claiming the file cannot be read after it demonstrably can.
     *
     * TWO NARROWINGS MAKE THIS SAFE, and they are what let this effect exist at all where the
     * comment above once ruled it out.
     *
     * 1. IT RETIRES ONLY `failed` AND `unknown` - the two statuses this route produces. React runs a
     *    child's effects BEFORE its parent's, so an unnarrowed retirement here would run after the
     *    import step's zero-row effect and undo the `invalid` marker on the very render that wrote
     *    it. `invalid` is not in the list, so that is now structurally impossible rather than merely
     *    avoided.
     *
     * 2. IT RUNS ONCE PER VISIT. The import step records its own `failed`/`unknown` marker when an
     *    import ATTEMPT is refused, and that marker describes the attempt rather than the file, so it
     *    must survive. Because this fires only on the first commit that carries loaded details -
     *    before any attempt can have been made - a later re-read of the details cannot bring it back
     *    round to erase one.
     */
    const loadedBankAccount = data?.message?.doc?.bank_account
    const hasRetiredRefusalMarker = useRef(false)

    useEffect(() => {
        if (!id || !loadedBankAccount || hasRetiredRefusalMarker.current) {
            return
        }

        hasRetiredRefusalMarker.current = true

        setImportFailures((previousAttempts) => withoutImportAttempt(
            withoutImportAttempt(previousAttempts, loadedBankAccount, id, 'failed'),
            loadedBankAccount,
            id,
            'unknown'
        ))
    }, [id, loadedBankAccount, setImportFailures])

    /*
     * GUARD ORDER IS LOAD-BEARING. These three checks previously ran in the opposite order, with
     * the `!data` bail-out first, and that made the two branches below unreachable in exactly the
     * cases they exist for: a failed request returns no data, so `!data` was true and the component
     * returned null BEFORE the error branch could render, and the loading branch was dead for the
     * same reason.
     *
     * The practical consequence was the FM2 failure that matters most here. A malformed or empty
     * statement file fails while `get_statement_details` parses it, so opening that import log
     * rendered a completely blank page - no message, no explanation, no way back - while the
     * backend's own error sat unused in `error`. Loading and error are transient states that must be
     * reported; "no data and nothing wrong" is the only case that legitimately renders nothing.
     */
    if (isLoading) {
        return <div>Loading...</div>
    }

    if (error) {
        return <div className='flex flex-col gap-4 px-4'>
            <div>
                <Button size='sm' variant='outline' asChild>
                    <Link to="/statement-importer">
                        {direction === 'ltr' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                        {_("Back")}
                    </Link>
                </Button>
            </div>
            {/*
              * Normalised through the shared layer for the same reason every other surface is: when a
              * response is lost there is no Frappe envelope to render and the SDK's own unguarded read
              * of `error.response.data` surfaces as a raw `TypeError`. A genuine envelope passes
              * through by identity, so the backend's own wording reaches the reviewer verbatim.
              */}
            <ErrorBanner error={toDisplayError(error)} />
        </div>
    }

    if (!data || !data.message) {
        return null
    }

    const isPdf = data.message.doc.file?.toLowerCase().endsWith('.pdf')

    if (isPdf) {
        return <PDFImport data={data} mutate={mutate} />
    }

    return <CSVImport data={data} mutate={mutate} />
}

export default ViewBankStatementImportLog

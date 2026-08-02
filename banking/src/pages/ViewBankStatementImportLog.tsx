import { lazy } from 'react'
import { useGetStatementDetails } from '@/components/features/BankStatementImporter/import_utils'
import { Button } from '@/components/ui/button'
import { useDirection } from '@/components/ui/direction'
import ErrorBanner from '@/components/ui/error-banner'
import _ from '@/lib/translate'
import { useFrappeDocumentEventListener } from 'frappe-react-sdk'
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
            <ErrorBanner error={error} />
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
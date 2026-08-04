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
     * FM2: LOADING -> ERROR -> NO DATA, and the order is the whole of the fix.
     *
     * The no-data guard used to run FIRST, and `useFrappeGetCall` returns no data on a FAILED read as
     * well as on a pending one - so every refusal of `get_statement_details` returned `null` from here
     * and the two branches below became unreachable. A reviewer who followed an import log whose file
     * had been deleted, whose bank account they lacked permission on, or whose PDF password was
     * missing was shown a BLANK PAGE: no message, no explanation, and not even the Back control. The
     * error banner and the Back link existed and were simply never rendered.
     *
     * Loading is tested first because SWR reports it while `data` and `error` are both absent, and a
     * pending read must not be reported as a failure.
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
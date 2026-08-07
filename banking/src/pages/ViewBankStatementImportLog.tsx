import { lazy } from 'react'
import { useGetStatementDetails } from '@/components/features/BankStatementImporter/import_utils'
import { Button } from '@/components/ui/button'
import { useDirection } from '@/components/ui/direction'
import ErrorBanner from '@/components/ui/error-banner'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { TableLoader } from '@/components/ui/loaders'
import _ from '@/lib/translate'
import { useFrappeDocumentEventListener } from 'frappe-react-sdk'
import { ChevronLeftIcon, ChevronRightIcon, FileQuestionIcon } from 'lucide-react'
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
     * Order matters here, and getting it wrong is how this screen came to render nothing at all.
     *
     * The no-data guard used to run FIRST. Since `data` is undefined both while the request is in flight
     * and after it fails, that one `return null` swallowed the two states below it: a reviewer who opened
     * a log whose file had been removed from disk got a breadcrumb over an empty page - identical to the
     * pending state, with no error, no explanation and no way back except the browser's own button.
     *
     * So: pending first, failure second, and only then the genuinely empty answer - which is itself a
     * state worth naming rather than a blank.
     */
    if (isLoading) {
        return <div className='flex flex-col gap-4 px-4'>
            <div className='sr-only' role='status'>{_("Loading")}</div>
            <TableLoader rows={8} columns={5} />
        </div>
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
        return <div className='flex flex-col gap-4 px-4'>
            <div>
                <Button size='sm' variant='outline' asChild>
                    <Link to="/statement-importer">
                        {direction === 'ltr' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                        {_("Back")}
                    </Link>
                </Button>
            </div>
            <Empty>
                <EmptyMedia>
                    <FileQuestionIcon />
                </EmptyMedia>
                <EmptyHeader>
                    <EmptyTitle>{_("This statement import could not be opened")}</EmptyTitle>
                    <EmptyDescription>
                        {/* Named when the route gave us a name to report - it is what the reviewer needs in
                            order to say which import is missing - and left general when it did not, rather
                            than trailing off after "nothing for". */}
                        {id
                            ? _("The server returned nothing for {}. It may have been deleted since the list was loaded.", [id])
                            : _("The server returned nothing for this import. It may have been deleted since the list was loaded.")}
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        </div>
    }

    const isPdf = data.message.doc.file?.toLowerCase().endsWith('.pdf')

    if (isPdf) {
        return <PDFImport data={data} mutate={mutate} />
    }

    return <CSVImport data={data} mutate={mutate} />
}

export default ViewBankStatementImportLog
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
     * GUARD ORDER: loading -> error -> no data, and it has to be that way round.
     *
     * `useFrappeGetCall` reports `data` as `undefined` for a read that is still pending AND for one that
     * was refused, so "no data" is the WEAKEST of the three conditions and says nothing on its own.
     * Testing it first - as this component used to - meant a refused `get_statement_details` returned
     * `null` before the error branch was ever reached: the reviewer saw a completely blank page, with no
     * message explaining the refusal and no way back to the list. Insufficient permission on
     * `Bank Statement Import Log` (the DocType is System Manager only) and a deleted or renamed log both
     * land there.
     *
     * Ordering the guards by decreasing information puts each answer under the condition that actually
     * implies it: a pending read renders the loader, a refused one renders the server's own message with
     * a Back control, and only a settled, successful read with nothing in it falls through to the last
     * branch.
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
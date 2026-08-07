import CSVRawDataPreview from './CSVRawDataPreview'
import StatementDetails from './StatementDetails'
import { GetStatementDetailsResponse } from '../import_utils'

const CSVImport = ({ data, mutate }: { data: { message: GetStatementDetailsResponse }, mutate: () => void }) => {

    /*
     * Stacks below `xl` rather than holding a 50/50 split at every width.
     *
     * Two consequences of the fixed split made this the review screen's most serious defect: the reviewed
     * FIGURES - the debit and credit totals, the closing balance, the detected formats - were squeezed
     * into a pane too narrow to read them in, while the Import control at the top of that same pane stayed
     * enabled and was partly overpainted by the pane beside it. A reviewer could commit an import without
     * having been able to see what they were committing.
     *
     * Stacking puts the details and the raw rows in ONE scroll flow, in that order, so the summary sits
     * directly above the control that acts on it. The fixed pane height only applies once they are side by
     * side; stacked, each pane sizes to its content and the page scrolls, because two independently
     * scrolling full-height panes on a narrow screen hide the second one entirely.
     */
    return (
        <div className="w-full flex flex-col xl:flex-row">
            <div className="w-full xl:w-[50%] min-w-0 p-4 xl:h-[calc(100vh-72px)] xl:overflow-scroll">
                <StatementDetails data={data.message} />
            </div>
            <div className="w-full xl:w-[50%] min-w-0 border-t xl:border-s pe-1 ps-0 border-outline-gray-2 xl:h-[calc(100vh-72px)] xl:overflow-scroll">
                <CSVRawDataPreview data={data.message} mutate={mutate} />
            </div>
        </div>
    )
}

export default CSVImport
import StatementDetails from '../CSV/StatementDetails'
import PDFTableEditor from './PDFTableEditor'
import { GetStatementDetailsResponse } from '../import_utils'

type Props = {
    data: { message: GetStatementDetailsResponse }
    mutate: () => void
}

const PDFImport = ({ data, mutate }: Props) => {
    /* Stacks below `xl` for the same reason as the spreadsheet flow: see the note in `CSV/CSVImport.tsx`.
       The region editor beside it is the wider of the two here, which made the details pane narrower
       still. */
    return (
        <div className="w-full flex flex-col xl:flex-row">
            <div className="w-full xl:w-[45%] min-w-0 p-4 xl:h-[calc(100vh-72px)] xl:overflow-scroll">
                <StatementDetails data={data.message} />
            </div>
            <div className="w-full xl:w-[55%] min-w-0 border-t xl:border-t-0 xl:border-s pe-1 ps-0 border-outline-gray-2 xl:h-[calc(100vh-72px)] xl:overflow-scroll">
                <PDFTableEditor data={data.message} mutate={mutate} />
            </div>
        </div>
    )
}

export default PDFImport

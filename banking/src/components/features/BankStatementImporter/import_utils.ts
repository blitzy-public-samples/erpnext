import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog"
import { useFrappeGetCall, useFrappePostCall } from "frappe-react-sdk"

export type ColumnMapsTo =
    | "Do not import"
    | "Date"
    | "Withdrawal"
    | "Deposit"
    | "Amount"
    | "Description"
    | "Reference"
    | "Transaction Type"
    | "Debit/Credit"
    | "Balance"
    | "Included Fee"
    | "Excluded Fee"
    | "Party Name/Account Holder"
    | "Party Account No."
    | "Party IBAN"

export type ColumnMappingEntry = {
    index: number
    maps_to: ColumnMapsTo | string
    header_text?: string
    variable?: string
}

/** Apply a column mapping change, clearing the same mapping from any other column. */
export function applyColumnMappingChange<T extends ColumnMappingEntry>(
    columns: T[],
    columnIndex: number,
    mapsTo: ColumnMapsTo,
): T[] {
    const previous = columns.find((c) => c.index === columnIndex)
    const cleared =
        mapsTo === "Do not import"
            ? columns
            : columns.map((c) =>
                  c.index !== columnIndex && c.maps_to === mapsTo
                      ? { ...c, maps_to: "Do not import" as ColumnMapsTo }
                      : c,
              )

    return [
        ...cleared.filter((c) => c.index !== columnIndex),
        {
            index: columnIndex,
            maps_to: mapsTo,
            header_text: previous?.header_text ?? "",
            variable: previous?.variable ?? `column_${columnIndex}`,
        } as T,
    ].sort((a, b) => a.index - b.index)
}

export const COLUMN_MAPS_TO_OPTIONS: ColumnMapsTo[] = [
    "Do not import",
    "Date",
    "Description",
    "Reference",
    "Withdrawal",
    "Deposit",
    "Amount",
    "Balance",
    "Debit/Credit",
    "Transaction Type",
    "Included Fee",
    "Excluded Fee",
    "Party Name/Account Holder",
    "Party Account No.",
    "Party IBAN",
]

export interface PDFTableColumn {
    index: number
    header_text: string
    variable?: string
    maps_to: ColumnMapsTo
}

export interface PDFTable {
    page: number
    table_index: number
    bbox: [number, number, number, number]
    page_width: number
    page_height: number
    page_image: string | null
    render_scale: number | null
    rows: string[][]
    header_index: number | null
    column_mapping: PDFTableColumn[]
    date_format?: string
    amount_format?: string
    included: boolean
}

export interface GetStatementDetailsResponse {
    doc: BankStatementImportLog,
    conflicting_transactions: Array<{
        name: string,
        date: string,
        withdrawal: number,
        deposit: number,
        description: string,
        reference_number: string,
        currency: string,
    }>,
    final_transactions: Array<{
        date: string,
        withdrawal: number,
        deposit: number,
        description: string,
        reference: string,
        transaction_type?: string,
        debit_credit?: string,
        included_fee?: number,
        excluded_fee?: number,
        party_name?: string,
        party_account_number?: string,
        party_iban?: string,
    }>,
    date_format: string,
    raw_data: Array<Array<string>>,
    pdf_tables?: PDFTable[],
    /*
     * NOTE: there is deliberately NO top-level `currency` member here.
     *
     * `get_statement_details` returns exactly `doc`, `date_format`, `conflicting_transactions`,
     * `final_transactions` and `raw_data` - plus `pdf_tables` on the PDF branch
     * (`bank_statement_import_log.py:1156-1177`). A response-level currency was declared here but
     * never sent, so every consumer reading it received `undefined` and `formatCurrency` silently
     * fell back to the SYSTEM default: a statement on a non-default-currency bank account had every
     * one of its amounts labelled with the wrong symbol, while the type asserted the opposite.
     *
     * The currency of a statement is `doc.currency`, a native read-only field on
     * `Bank Statement Import Log` populated from the bank account's GL account currency. Read it
     * from there.
     */
}

export const useGetStatementDetails = (id: string) => {
    return useFrappeGetCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.get_statement_details", {
        statement_import_id: id,
    }, undefined, {
        revalidateOnFocus: false
    })

}

export const useUpdatePDFTables = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.update_pdf_tables")
}

export const useReextractPDFTable = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.reextract_pdf_table")
}

export const useSetPDFTableHeader = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.set_pdf_table_header")
}

export const useUpdateColumnMapping = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.update_column_mapping")
}

export const useSetHeaderIndex = () => {
    return useFrappePostCall<{ message: GetStatementDetailsResponse }>("erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.set_header_index")
}
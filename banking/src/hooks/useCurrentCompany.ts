import { useAtomValue } from "jotai"
import { atomWithStorage } from "jotai/utils"

/*
 * `getOnInit` matters here, and its absence was a real defect rather than an omission of tidiness.
 *
 * `selectedBankAccountAtom` IS declared with `getOnInit: true`, so a persisted bank account is present
 * on the very FIRST render. Without it here, this atom yielded its initial value on that same render and
 * only picked the stored company up afterwards - so for one render the app held a bank account and no
 * company. Every hook that pairs the two then fired a request with the bank account and no company, and
 * `bank_reconciliation_tool.get_account_balance` and `bank_account.get_list` both take `company` as a
 * REQUIRED positional argument: the result was an HTTP 500 `TypeError: ... missing 1 required positional
 * argument: 'company'`, twice, with a full traceback, on every cold load carrying a stored bank account.
 * Reading storage on init makes the two atoms hydrate together, which is what the pairing assumes.
 */
export const selectedCompanyAtom = atomWithStorage<string>('bank-rec-selected-company', window.frappe?.boot?.user?.defaults?.company || '', undefined, {
    getOnInit: true
})

export const useCurrentCompany = () => {
    const selectedCompany = useAtomValue(selectedCompanyAtom)
    return selectedCompany ? selectedCompany : (window.frappe?.boot?.user?.defaults?.company as string)
}
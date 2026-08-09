import { Button } from "@/components/ui/button"
import { selectedCompanyAtom, useCurrentCompany } from "@/hooks/useCurrentCompany"
import { useSetAtom } from "jotai"
import { Building2, Check, ChevronDown } from "lucide-react"
import { useState } from "react"
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import _ from "@/lib/translate"
import { selectedBankAccountAtom } from "./bankRecAtoms"

const CompanySelector = ({ onChange }: { onChange?: (company: string) => void }) => {
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = window.frappe?.boot?.docs?.filter((doc: Record<string, any>) => doc.doctype === ":Company").map((company: Record<string, any>) => company.name) || []

    const setSelectedCompany = useSetAtom(selectedCompanyAtom)
    const setSelectedBankAccount = useSetAtom(selectedBankAccountAtom)
    const selectedCompany = useCurrentCompany()

    const handleSelectCompany = (company: string) => {
        setSelectedCompany(company)
        setSearchQuery("")
        setOpen(false)
        // Only reset bank account if the company is changed
        if (selectedCompany !== company) {
            setSelectedBankAccount(null)
            onChange?.(company)
        }
    }

    return (<Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
            {/*
                The name states the PURPOSE as well as the value. On its own the control announced only
                "_Test Company, combo box" - the value with nothing to say what choosing a different one
                would change, on a screen where a second combobox beside it announces a date range the
                same way. The value is folded into the name because `aria-label` replaces an element's
                text content in the name computation, so it has to carry both.
            */}
            <Button
                variant="outline"
                type='button'
                role="combobox"
                size='md'
                aria-expanded={open}
                aria-label={_("Company: {0}", [selectedCompany ?? ''])}
                className="justify-between"
            >
                <div className="flex items-center gap-2">
                    <Building2 aria-hidden="true" />
                    {selectedCompany}
                </div>
                <ChevronDown aria-hidden="true" className="text-ink-gray-4" />
            </Button>
        </PopoverTrigger>
        <PopoverContent className="min-w-56 w-fit p-0">
            <Command value={selectedCompany}>
                {options.length > 5 && <CommandInput placeholder={_("Search company...")} className="h-9" />}
                <CommandList>
                    <CommandEmpty>{_("No company found.")}</CommandEmpty>
                    <CommandGroup>
                        {options.map((option: string) => (
                            <CommandItem
                                key={option}
                                value={option}
                                onSelect={(currentValue) => {
                                    handleSelectCompany(currentValue)
                                }}
                            >
                                {option}
                                <Check
                                    className={cn(
                                        "ms-auto",
                                        searchQuery === option ? "opacity-100" : "opacity-0"
                                    )}
                                />
                            </CommandItem>
                        ))}
                    </CommandGroup>
                </CommandList>
            </Command>
        </PopoverContent>
    </Popover>)
}

export default CompanySelector
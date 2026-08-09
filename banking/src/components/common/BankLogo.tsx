import { cn } from '@/lib/utils'
import { SelectedBank } from '../features/BankReconciliation/bankRecAtoms'
import { useTheme } from '../ui/theme-provider'
import { Landmark } from 'lucide-react'
import { H2 } from '../ui/typography'

const BankLogo = ({ bank, className, imageClassName, iconSize = '18px', iconClassName }: { bank?: SelectedBank | null, className?: string, imageClassName?: string, iconSize?: string, iconClassName?: string }) => {

    const { themeValue } = useTheme()
    return (
        <div className={cn('h-6 flex items-center gap-1', className)}> {bank?.logo ? <img
            src={`/assets/erpnext/images/bank-logos/${themeValue === 'Dark' ? (bank.logoDark ?? bank.logo) : bank.logo}`}
            alt={bank.bank || bank.name || ''}
            className={cn("h-6 max-w-22 me-auto object-contain", imageClassName, {
                'dark:invert dark:brightness-0': bank.darkModeInvert
            }, bank.logoClassName)}
        /> : <>
            <Landmark size={iconSize} className={iconClassName} />
            {/*
                A level-TWO heading, not four. The page's only `h1` is its title, so an `h4` here made
                every route's outline jump h1 -> h4 with nothing between, which is what both axe and
                Lighthouse flagged. `border-0 p-0` strips the H2 primitive's decorative underline and
                padding - the convention already used elsewhere in this codebase - so the rendered
                heading is pixel-identical to before.
            */}
            <H2 className={cn("text-xs -mb-0.5 border-0 p-0", {
            })}>{bank?.bank ?? ''}</H2>
        </>
        }</div>
    )
}

export default BankLogo
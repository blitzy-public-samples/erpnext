import { cn } from "@/lib/utils"

export const StatContainer = ({ children, className }: { children: React.ReactNode, className?: string }) => {
    return <div data-slot="stat-container" className={cn("flex flex-col gap-1.5 p-2", className)}>{children}</div>
}

export const StatLabel = ({ children, className }: { children: React.ReactNode, className?: string }) => {
    return <span data-slot="stat-label" className={cn("uppercase text-2xs font-medium text-ink-gray-6", className)}>{children}</span>
}

export const StatValue = ({ children, className }: { children: React.ReactNode, className?: string }) => {
    return <span data-slot="stat-value" className={cn("text-xl text-ink-gray-8 font-semibold tabular-nums", className)}>{children}</span>
}
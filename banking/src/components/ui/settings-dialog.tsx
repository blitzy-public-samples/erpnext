import * as React from "react"
import { Tabs as TabsPrimitive, Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { DialogContent } from "./dialog"

/**
 * Sample Usage:
 *
 * <Dialog open={open} onOpenChange={setOpen}>
 * <DialogTrigger>
 * ...your content...
 * </DialogTrigger>
 * 
 *   <SettingsDialog onClose={() => setOpen(false)} defaultValue="preferences">
 *     <SettingsTabs>
 *       <SettingsTabGroup header="Configuration">
 *         <SettingsTabItem icon={<SlidersVerticalIcon />} label="Preferences" value="preferences" />
 *         <SettingsTabItem icon={<ZapIcon />} label="Matching Rules" value="rules" />
 *       </SettingsTabGroup>
 *       <SettingsTabGroup header="Setup">
 *         <SettingsTabItem icon={<LandmarkIcon />} label="Bank Accounts" value="bank-accounts" />
 *         <SettingsTabItem icon={<ListIcon />} label="Masters" value="masters" />
 *       </SettingsTabGroup>
 *     </SettingsTabs>
 *
 *     <SettingsPanels>
 *       <SettingsPanel value="preferences"><Preferences /></SettingsPanel>
 *       <SettingsPanel value="rules"><MatchingRules /></SettingsPanel>
 *       <SettingsPanel value="bank-accounts"><BankAccounts /></SettingsPanel>
 *       <SettingsPanel value="masters"><Masters /></SettingsPanel>
 *     </SettingsPanels>
 *   </SettingsDialog>
 * </Dialog>
 */

type SettingsDialogContextValue = {
    onClose?: VoidFunction
}

const SettingsDialogContext = React.createContext<SettingsDialogContextValue>({})

/**
 * Exposes `onClose` to descendant panels so they can dismiss the dialog after
 * a successful save without prop-drilling.
 */
export const useSettingsDialog = () => React.useContext(SettingsDialogContext)

type SettingsDialogProps = Omit<
    React.ComponentProps<typeof TabsPrimitive.Root>,
    "orientation"
> & {
    onClose?: VoidFunction
    contentClassName?: string
}

function SettingsDialog({
    children,
    className,
    contentClassName,
    onClose,
    ...props
}: SettingsDialogProps) {
    const contextValue = React.useMemo(() => ({ onClose }), [onClose])

    return (
        /*
         * Width comes from the primitive's clamped size set, and the close control is BACK.
         *
         * The old expression was `min-w-5xl max-lg:min-w-[98vw]`, which had an exact-boundary bug: `max-lg`
         * means *below* 64rem, and `5xl` IS 64rem - so at precisely 1024px neither branch left a gutter and
         * the dialog ran edge to edge. `size="5xl"` clamps to `min(64rem, 100vw - 2rem)`, which has no
         * boundary to get wrong.
         *
         * `showCloseButton` was false and nothing replaced it: the only ways out of the settings dialog
         * were Escape and a click on the overlay, neither of which is visible, and neither of which a
         * reviewer who does not already know them will find. It is restored, and positioned in the panel's
         * own padding rather than the dialog's, so it cannot collide with the tab rail.
         */
        <DialogContent
            size="5xl"
            className={cn("p-0 overflow-hidden [&>[data-slot=dialog-close]]:top-4 [&>[data-slot=dialog-close]]:ltr:right-4 [&>[data-slot=dialog-close]]:rtl:left-4 [&>[data-slot=dialog-close]]:z-20", contentClassName)}>
            <SettingsDialogContext.Provider value={contextValue}>
                <TabsPrimitive.Root
                    data-slot="settings-dialog"
                    orientation="vertical"
                    className={cn(
                        // `min-w-0` here is the one that actually contains the dialog, and it is easy to
                        // mistake for a duplicate of the `min-w-0` on `SettingsPanels`. They do different
                        // jobs. `DialogContent` is `display:grid`, so THIS element is a grid item, and a
                        // grid item's default `min-width:auto` resolves to its content-based minimum -
                        // meaning the widest thing anywhere inside the dialog set the width of this row,
                        // and any excess spilled outside the dialog's clipping box where it could neither
                        // be seen nor clicked. `min-w-0` on `SettingsPanels` alone could not prevent that:
                        // a `min-width` of 0 is a floor that PERMITS shrinking, not a cap that forces it,
                        // and nothing was forcing it while this row was free to grow. Clamping the grid
                        // item pins the row to the grid area, which in turn is what finally gives the
                        // panel a definite width to shrink into and lets text truncation take effect.
                        "flex h-[calc(100vh-8rem)] min-w-0 bg-surface-menu-bar",
                        className
                    )}
                    {...props}
                >
                    {children}
                </TabsPrimitive.Root>
            </SettingsDialogContext.Provider>
        </DialogContent>
    )
}

function SettingsTabs({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
    return (
        <TabsPrimitive.List
            data-slot="settings-tabs"
            className={cn(
                "flex flex-col w-56 bg-surface-menu-bar rounded-s-lg shrink-0 overflow-y-auto m-1",
                className
            )}
            {...props}
        />
    )
}

type SettingsTabGroupProps = React.ComponentProps<"div"> & {
    header?: React.ReactNode
}

function SettingsTabGroup({
    children,
    header,
    className,
    ...props
}: SettingsTabGroupProps) {
    return (
        /*
         * Every wrapper between the tablist and its tabs is `role="presentation"`, and the inner one used
         * to be a `<nav>`.
         *
         * ARIA requires a `tablist` to OWN its `tab` children, and this group sits between the two - so
         * with a landmark and two generic containers in the way, the settings rail exposed a tablist with
         * no tabs in it and a navigation landmark nested inside a composite widget, neither of which is
         * valid. `role="presentation"` removes only the wrapper itself from the accessibility tree, so the
         * tabs become direct children of the tablist there while the DOM and the styling are untouched.
         *
         * The group header is hidden from the tree for the same reason: it is a bare text node inside the
         * tablist, and its wording repeats the dialog's own title, so it carries nothing a screen-reader
         * user would lose. It stays visible.
         */
        <div data-slot="settings-tab-group" role="presentation" className={className} {...props}>
            {header && (
                <div aria-hidden="true" className="h-7.5 px-2 py-[7px] my-[3px] flex cursor-default gap-1.5 text-xs font-medium text-ink-gray-5 transition-all duration-300 ease-in-out sticky top-0 z-10 bg-surface-menu-bar">
                    <span>{header}</span>
                </div>
            )}
            <div role="presentation" className="space-y-[3px] px-1">{children}</div>
            <div aria-hidden="true" className="mb-0.5 mt-[5px]"></div>
        </div>
    )
}

type SettingsTabItemProps = React.ComponentProps<typeof TabsPrimitive.Trigger> & {
    icon?: React.ReactNode
    label: React.ReactNode
}

function SettingsTabItem({
    icon,
    label,
    className,
    ...props
}: SettingsTabItemProps) {
    return (
        <TabsPrimitive.Trigger
            data-slot="settings-tab-item"
            className={cn(
                /*
                 * The focus ring was `outline-gray-3`, which resolves to gray-400 in light and
                 * gray-500 in dark and measures 1.44-1.69:1 against the three surfaces this tab can
                 * sit on (menu bar, hover, selected) and 1.26-1.91:1 in dark - so the keyboard
                 * position was effectively unmarked. `outline-gray-5` is the ramp's focus value and
                 * measures 10.0-11.7:1 light and 5.8-8.7:1 dark on the same three surfaces, clearing
                 * the 3:1 non-text floor with room to spare. Token-for-token within the existing
                 * ramp: no new colour and no geometry change.
                 */
                "flex h-7.5 cursor-pointer items-center rounded text-ink-gray-6 duration-300 ease-in-out focus:outline-none focus:transition-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-outline-gray-5 w-full",
                "hover:bg-surface-gray-3",
                "data-[state=active]:bg-surface-selected data-[state=active]:shadow-sm data-[state=active]:hover:bg-surface-selected",
                className
            )}
            {...props}
        >
            <div className="flex w-full items-center justify-between duration-300 ease-in-out px-2 py-[7px]">
                <div className="flex items-center truncate">
                    {icon && (
                        <div className="[&_svg:not([class*='size-'])]:size-4 text-ink-gray-6 [&_svg:not([class*='text-'])]:text-ink-gray-6">
                            {icon}
                        </div>
                    )}
                    <span
                        className={cn(
                            "flex-1 shrink-0 truncate text-sm leading-4 duration-300 ease-in-out w-auto opacity-100 text-ink-gray-6",
                            icon && "ms-2"
                        )}
                    >
                        {label}
                    </span>
                </div>
            </div>
        </TabsPrimitive.Trigger>
    )
}

function SettingsPanels({
    className,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="settings-panels"
            className={cn(
                // `min-w-0` is load-bearing, not cosmetic. This element is the `flex-1` child of the
                // dialog's flex row, and a flex item's default `min-width:auto` means it can never
                // shrink below its own min-content width. A single wide, untruncated descendant (for
                // example a long Bank Transaction Rule name) therefore inflated the whole flex row
                // past the dialog's fixed `min-w-5xl`, which pushed the panel header's action buttons
                // outside the dialog's clipping box and made them impossible to hit-test or click.
                // Clamping to `min-w-0` pins the panel to the dialog's width; because this element is
                // already an overflow container, any content that is still too wide now scrolls
                // inside the panel instead of displacing the dialog's own chrome.
                "flex flex-col flex-1 min-w-0 overflow-y-auto bg-surface-modal",
                className
            )}
            {...props}
        />
    )
}

function SettingsPanel({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
    return (
        <TabsPrimitive.Content
            data-slot="settings-panel"
            className={cn("flex flex-col h-full w-full text-ink-gray-8 py-8 px-6 gap-6", className)}
            {...props}
        />
    )
}

/**
 * Usage:
 * 
 * <SettingsPanelHeader actions={<><Button>Add</Button></>}>
 * 
 * <SettingsPanelTitle>Settings</SettingsPanelTitle>
 * <SettingsPanelDescription>Settings description</SettingsPanelDescription>
 * 
 * </SettingsPanelHeader>
 */
function SettingsPanelHeader({
    className,
    children,
    actions,
    ...props
}: React.ComponentProps<"div"> & { actions?: React.ReactNode }) {
    return (
        <div
            data-slot="dialog-header"
            className={cn("flex justify-between items-start px-2 text-ink-gray-7", className)}
            {...props}
        >
            <div className="flex flex-col gap-1 w-full">
                {children}
            </div>
            <div className="flex item-center space-x-2 w-fit justify-end">
                {actions}
            </div>
        </div>
    )
}

function SettingsPanelTitle({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
    return (
        <DialogPrimitive.Title
            data-slot="dialog-title"
            className={cn("flex gap-2 text-xl font-semibold leading-none h-5", className)}
            {...props}
        />
    )
}

function SettingsPanelDescription({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
    return (
        <DialogPrimitive.Description
            data-slot="dialog-description"
            className={cn("text-p-base text-ink-gray-6", className)}
            {...props}
        />
    )
}

function SettingsPanelContent({
    className,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div className={cn("flex-1 flex flex-col overflow-y-auto px-2", className)} {...props} />
    )
}

export {
    SettingsDialog,
    SettingsTabs,
    SettingsTabGroup,
    SettingsTabItem,
    SettingsPanels,
    SettingsPanel,
    SettingsPanelHeader,
    SettingsPanelTitle,
    SettingsPanelDescription,
    SettingsPanelContent
}

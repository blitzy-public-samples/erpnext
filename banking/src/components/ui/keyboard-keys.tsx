import _ from "@/lib/translate"

/*
 * The modifier keys these shortcuts are REGISTERED with, spelled the way the platform the reviewer is
 * on spells them.
 *
 * This matters because the documentation and the registration had drifted apart. Every shortcut is
 * registered with `react-hotkeys-hook` as `meta+…`, and `meta` is the Command key on macOS but the
 * Super / Windows key everywhere else - yet this component printed "Ctrl" on every non-Mac platform.
 * A reviewer on Linux was told to press a key combination that does nothing, six times over, while the
 * combination that does work was named nowhere. The registrations are deliberately left alone: they are
 * existing behaviour, and re-registering six shortcuts onto Ctrl would collide with the browser's own
 * Ctrl+P / Ctrl+B / Ctrl+I. So the label is corrected to describe what is actually bound.
 *
 * Each key also carries an accessible name, because a bare glyph is not a word: a screen reader
 * announces U+2318 as "place of interest sign", and announced nothing at all for the shift glyph.
 */

/**
 * Whether the reviewer is on a Mac, and therefore whether `meta` means Command.
 *
 * `navigator.userAgentData.platform` is the supported signal and is preferred where the browser has it;
 * `navigator.platform` is deprecated but is the only thing Safari and older browsers offer, and the user
 * agent string is the last resort. All three are read defensively because this module renders during the
 * first paint, and a headless or embedded runtime may expose none of them.
 */
const isMacPlatform = (): boolean => {
    if (typeof navigator === "undefined") return false

    const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string }
    }).userAgentData

    const platform = uaData?.platform || navigator.platform || navigator.userAgent || ""

    return /mac/i.test(platform)
}

/** Whether the reviewer is on Windows, where `meta` is the Windows key rather than Super. */
const isWindowsPlatform = (): boolean => {
    if (typeof navigator === "undefined") return false

    const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string }
    }).userAgentData

    const platform = uaData?.platform || navigator.platform || navigator.userAgent || ""

    return /win/i.test(platform) && !/mac/i.test(platform)
}

/**
 * One key cap. `role="img"` with a name rather than bare text, so the glyph forms are announced as the
 * key they represent instead of as their Unicode description.
 */
const KeyCap = ({ label, children }: { label: string, children: React.ReactNode }) => (
    <span role="img" aria-label={label} className="text-sm">{children}</span>
)

/** The `meta` modifier: Command on macOS, the Windows key on Windows, Super elsewhere. */
export const KeyboardMetaKeyIcon = () => {
    if (isMacPlatform()) {
        return <KeyCap label={_("Command")}>⌘</KeyCap>
    }

    if (isWindowsPlatform()) {
        return <KeyCap label={_("Windows key")}>Win</KeyCap>
    }

    return <KeyCap label={_("Super key")}>Super</KeyCap>
}

/** The `alt` modifier: Option on macOS, Alt elsewhere. */
export const KeyboardAltKeyIcon = () => {
    if (isMacPlatform()) {
        return <KeyCap label={_("Option")}>⌥</KeyCap>
    }

    return <KeyCap label={_("Alt")}>Alt</KeyCap>
}

/** The `shift` modifier. The glyph is universal, but it still needs a name to be announced. */
export const KeyboardShiftKeyIcon = () => (
    <KeyCap label={_("Shift")}>⇧</KeyCap>
)

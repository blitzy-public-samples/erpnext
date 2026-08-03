import { FrappeError } from "frappe-react-sdk"

interface ParsedErrorMessage {
    message: string,
    title?: string,
    indicator?: string,
}


export const getErrorMessage = (error?: FrappeError | null): string => {
    const messages = getErrorMessages(error)
    return messages.map(m => m.message).join('\n')
}

/**
 * `JSON.parse` that REPORTS failure instead of raising it.
 *
 * Every parse in this module is of data the server sent, so none of it can be assumed
 * well-formed: a proxy that truncates a response, an app that writes its own value into
 * `_server_messages`, or a framework version that changes the encoding all produce input this
 * module still has to render something for. Returning `undefined` lets each caller decide what
 * to do with an unusable value, which is what keeps the decision out of a `catch` block.
 */
const parseJSON = (value: string): unknown => {
    try {
        return JSON.parse(value)
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    catch (e) {
        return undefined
    }
}

/**
 * True for a parsed entry that already carries renderable text.
 *
 * `ErrorBanner` (`ui/error-banner.tsx:39-45`) reads `indicator` off the FIRST entry and hands
 * every entry's `message` to the markdown renderer, so an entry without a string `message` is
 * not merely unusual - it renders as nothing at all, which is how a backend refusal became
 * invisible. A blank message counts as absent for the same reason.
 */
const hasRenderableMessage = (value: unknown): value is ParsedErrorMessage =>
    typeof value === 'object' && value !== null &&
    typeof (value as ParsedErrorMessage).message === 'string' &&
    (value as ParsedErrorMessage).message.trim() !== ''

/**
 * The text an entry still carries once it is established that it is not a renderable message.
 * Deliberately lossless in preference to tidy: text the server sent is diagnostic even when its
 * shape is wrong, and discarding it would leave the reviewer with an empty dialog.
 *
 * Cannot raise. `JSON.stringify` throws only on a circular structure and returns `undefined`
 * only for a value `String` handles, so both are covered without a second failure path.
 */
const describeUnrenderableEntry = (raw: unknown): string => {
    if (typeof raw === 'string') return raw

    try {
        return JSON.stringify(raw) ?? String(raw)
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    catch (e) {
        return String(raw)
    }
}

/**
 * Normalises ONE element of the `_server_messages` array into something renderable.
 *
 * Frappe transmits each element DOUBLE-encoded - a JSON array whose elements are themselves
 * JSON strings - so the ordinary case is a string that parses to an object. Two other cases
 * genuinely occur and neither may be allowed to reach a render as-is:
 *
 *   - an element that is not valid JSON (a singly encoded message, for instance). It used to be
 *     returned UNCHANGED, so the array held a bare `string` with no `.message`, and every
 *     consumer that read `.message` off it silently rendered nothing.
 *   - an element that parses to something other than a message object.
 *
 * A well-formed entry is returned BY IDENTITY, never rebuilt: FM1 requires the server's own
 * message, title and severity to reach the user verbatim, and rebuilding would quietly drop any
 * field this client does not know about. Anything else degrades to a red `Error` entry that
 * KEEPS the text, so a malformed refusal is still legible. `undefined` means "no text at all",
 * which lets the resolution chain below fall through to the remaining paths rather than
 * reporting an empty message.
 */
const normaliseServerMessage = (raw: unknown): ParsedErrorMessage | undefined => {
    if (raw === null || raw === undefined) return undefined

    const parsed = typeof raw === 'string' ? parseJSON(raw) : raw

    if (hasRenderableMessage(parsed)) return parsed

    // A decoded string is preferred over the raw element, so a singly encoded `"text"` reads as
    // `text` rather than carrying its transport quoting into the dialog.
    const text = (typeof parsed === 'string' ? parsed : describeUnrenderableEntry(raw)).trim()

    return text ? { message: text, title: "Error", indicator: "red" } : undefined
}

/**
 * Parses the `_server_messages` envelope.
 *
 * The outer parse is GUARDED. It previously ran outside the try/catch that guarded the
 * per-element parse, so a truthy but malformed envelope threw a `SyntaxError` straight out of
 * `getErrorMessages` - and because this module is the single path by which every backend refusal
 * reaches the user, that throw propagated into the render of whichever surface was reporting the
 * rejection. With no error boundary anywhere under `src/`, malformed error data could therefore
 * suppress the very dialog FM1 requires. It is now treated as what it is: one message whose text
 * is the raw envelope, which is unusual to read but never lost and never fatal.
 *
 * A parse that yields a single message rather than an array is wrapped, so the two encodings
 * resolve identically.
 */
const parseServerMessages = (serverMessages: string): ParsedErrorMessage[] => {
    const envelope = parseJSON(serverMessages)

    // `undefined` means the envelope did not parse, so the RAW value is the only text there is.
    // A parsed `null` is different - it is a well-formed envelope carrying no message - and is
    // left for `normaliseServerMessage` to discard, so resolution falls through to the paths
    // below rather than reporting the word "null" to a reviewer.
    const entries = Array.isArray(envelope) ? envelope : [envelope === undefined ? serverMessages : envelope]

    return entries
        .map(normaliseServerMessage)
        .filter((message): message is ParsedErrorMessage => message !== undefined)
}

/**
 * Standard function to parse the error messages from the FrappeError object
 * @param error The FrappeError object to parse
 * @returns An array of ParsedErrorMessage objects
 */
export const getErrorMessages = (error?: FrappeError | null): ParsedErrorMessage[] => {
    if (!error) return []
    let eMessages: ParsedErrorMessage[] = error?._server_messages ? parseServerMessages(error._server_messages) : []

    // @ts-expect-error - some errors have _error_message
    if (error?._error_message) {
        eMessages.push({
            // @ts-expect-error - some errors have _error_message
            message: error?._error_message,
            title: "Error",
            indicator: "red"
        })
    }

    if (eMessages.length === 0) {
        // Get the message from the exception by removing the exc_type
        const indexOfFirstColon = error?.exception?.indexOf(':')
        if (indexOfFirstColon) {
            const exception = error?.exception?.slice(indexOfFirstColon + 1)
            if (exception) {
                eMessages = [{
                    message: exception,
                    title: "Error"
                }]
            }
        }

        if (eMessages.length === 0) {
            eMessages = [{
                message: error?.message,
                title: "Error",
                indicator: "red"
            }]
        }
    }
    return eMessages

}

export const slug = (name?: string) => {
    return name?.toLowerCase().replace(/ /g, "-") ?? "";
}

export const scrub = (txt?: string) => {
    return (txt || "").replace(/ /g, "_").toLowerCase(); // use
}

export const unscrub = (txt?: string) => {
    return (txt || "").replace(/-|_/g, " ").replace(/\w*/g, function (keywords) {
        return keywords.charAt(0).toUpperCase() + keywords.substring(1).toLowerCase();
    });
}

export const getSystemDefault = (fieldName: string, fallback?: string) => {
    return window.frappe?.boot?.sysdefaults?.[fieldName] ?? fallback
}

export const getUserDefault = (fieldName: string, fallback?: string) => {
    return window.frappe?.boot?.user?.defaults?.[fieldName] ?? fallback
}

export const getBootFieldData = (fieldName: string, fallback?: string) => {
    return window.frappe?.boot?.[fieldName] ?? fallback
}
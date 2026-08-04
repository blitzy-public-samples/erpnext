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
 * Parses the `_server_messages` envelope WITHOUT EVER THROWING.
 *
 * The envelope is server-controlled and only conventionally well formed: Frappe transmits a JSON
 * array whose elements are themselves JSON strings, but a truncated response, a proxy that rewrote
 * the body, or a `frappe.msgprint` variant can deliver something else entirely. This function used
 * to call `JSON.parse` on it unguarded, and that single expression sat in front of every safety
 * action the failure paths perform - raising the dismissible dialog, recording the per-file import
 * failure, clearing the selection a refused reconcile attempt was made against, and revalidating
 * the authoritative reads. A malformed envelope therefore did not merely garble the message: it
 * threw out of the handler and abandoned all of them, which is the exact opposite of what this
 * module exists for. Every unparseable shape is treated as "this envelope carries no messages"
 * instead, so resolution falls through to `_error_message`, then `exception`, then `message`.
 *
 * A non-array parse result is discarded for the same reason - the caller is handed an array and
 * `.map` would throw on anything else.
 */
const parseServerMessages = (serverMessages?: string): unknown[] => {
    if (!serverMessages) return []

    try {
        const parsed: unknown = JSON.parse(serverMessages)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

/**
 * Standard function to parse the error messages from the FrappeError object
 * @param error The FrappeError object to parse
 * @returns An array of ParsedErrorMessage objects
 */
export const getErrorMessages = (error?: FrappeError | null): ParsedErrorMessage[] => {
    if (!error) return []
    let eMessages: ParsedErrorMessage[] = parseServerMessages(error?._server_messages)
        .map((m) => {
            try {

                // @ts-expect-error - it can sometimes be a string
                return JSON.parse(m)

            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            catch (e) {
                return m
            }
        })
        /*
         * A SINGLY encoded element is normalised rather than passed through. Frappe's convention is
         * double encoding, so the inner parse above is what turns each element into an object; when
         * an element is a bare string the inner parse throws and the string survives as-is. A plain
         * string has no `message` property, so the banner used to render `undefined` - an EMPTY body
         * with no heading - and the reviewer was told nothing at all about a refusal that did carry
         * text. Wrapping it here delivers that text instead, with the same red `Error` framing the
         * `_error_message` path uses.
         */
        .map((m) => (typeof m === 'string' ? { message: m, title: "Error", indicator: "red" } : m))
        /*
         * ...and an entry that still carries no readable `message` is DROPPED. Left in place it both
         * rendered an empty body and, because the array was non-empty, suppressed the
         * `_error_message` -> `exception` -> `message` fallback chain below - so a message-less entry
         * actively denied the reviewer text that was available elsewhere on the same envelope.
         */
        .filter((m): m is ParsedErrorMessage => Boolean(m && typeof m === 'object' && typeof m.message === 'string' && m.message.length > 0))

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
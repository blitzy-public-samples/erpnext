import { FrappeError } from "frappe-react-sdk"
import _ from "@/lib/translate"

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
 * True when the rejection carries no evidence of a server response at all - no HTTP status and no
 * exception - which means the request never reached Frappe or its reply never arrived.
 *
 * Worth stating why this needs detecting rather than falling through to `error.message`. The SDK
 * builds every rejection by spreading `error.response.data`, in both its call layer and its file
 * layer, WITHOUT guarding `response`. A transport-level failure - a dropped connection, a cancelled
 * request, an unreachable host - produces an axios error that has no `response`, so the SDK's own
 * handler throws while handling the failure and the rejection the SPA receives is that internal
 * `TypeError`. Its `message` reads "Cannot read properties of undefined (reading 'data')", which
 * says nothing to a reviewer and was being shown verbatim wherever an error is rendered.
 *
 * Only reached once no server message has been parsed, so a rejection Frappe actually spoke through
 * can never take this branch: `_server_messages`, `_error_message` and `exception` all outrank it and
 * still reach the reviewer word for word.
 */
const isTransportFailure = (error: FrappeError): boolean => !error?.exception && !error?.httpStatus

/**
 * Standard function to parse the error messages from the FrappeError object
 * @param error The FrappeError object to parse
 * @returns An array of ParsedErrorMessage objects
 */
export const getErrorMessages = (error?: FrappeError | null): ParsedErrorMessage[] => {
    if (!error) return []
    let eMessages: ParsedErrorMessage[] = error?._server_messages ? JSON.parse(error?._server_messages) : []
    eMessages = eMessages.map((m) => {
        try {

            // @ts-expect-error - it can sometimes be a string
            return JSON.parse(m)

        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        catch (e) {
            return m
        }
    })

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
        /*
         * A failure the server never got to speak about. The wording is deliberately OUTCOME-NEUTRAL:
         * with no response there is no way to know whether the operation was applied, so it says what
         * IS known - the reply never arrived - and points at the only safe next step, rather than
         * claiming nothing was changed. The internal message is withheld from the reviewer; the SDK
         * already logs the raw rejection to the console for whoever is debugging it.
         */
        if (isTransportFailure(error)) {
            return [{
                // Phrased to be true of a READ as well as a write: this one message serves every
                // surface, and "the request was not applied" would be a claim about the server that a
                // client with no reply cannot make - while a reviewer who was posting something does
                // need to be told the operation may still have landed.
                message: _("The server could not be reached, so no reply arrived. If this was an action, it may or may not have been applied. Check your network connection, then reload the page to see the current state before trying again."),
                title: _("Could not reach the server"),
                indicator: "red"
            }]
        }

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
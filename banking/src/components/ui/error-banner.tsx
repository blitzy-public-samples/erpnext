import { getErrorMessages } from '@/lib/frappe'
import { FrappeError } from 'frappe-react-sdk'
import { Alert, AlertDescription, AlertProps, AlertTitle } from '@/components/ui/alert'
import { AlertCircle, XIcon } from 'lucide-react'
import MarkdownRenderer from '@/components/ui/markdown'
import { Button } from '@/components/ui/button'
import _ from '@/lib/translate'
import { cn } from '@/lib/utils'
import { useMemo } from 'react'

type ErrorBannerProps = AlertProps & {
    error?: FrappeError | null,
    overrideHeading?: string,
    /**
     * Renders a dismiss control that calls this. OPTIONAL, and the banner is not dismissible without
     * it: an inline banner usually sits beside the control that produced the error and disappears on
     * the next attempt, so making every one of the call sites dismissible would invite a reviewer to
     * clear a message the screen still depends on. It exists for the banners that outlive their cause
     * - notably the upload form's, which had no other way to be cleared.
     *
     * The banner does not remember being dismissed; whoever owns the error owns that state, because
     * only they know when a new attempt should bring it back.
     */
    onDismiss?: VoidFunction,
}

interface ParsedErrorMessage {
    message: string,
    title?: string,
    indicator?: string,
}

const parseHeading = (message?: ParsedErrorMessage) => {
    if (message?.title === 'Message' || message?.title === 'Error') return _("There was an error.")
    return message?.title
}

const ErrorBanner = ({ error, overrideHeading, onDismiss, className, ...props }: ErrorBannerProps) => {


    //exc_type: "ValidationError" or "PermissionError" etc
    // exc: With entire traceback - useful for reporting maybe
    // httpStatus and httpStatusText - not needed
    // _server_messages: Array of messages - useful for showing to user
    // console.log(JSON.parse(error?._server_messages!))

    const messages = useMemo(() => {
        return getErrorMessages(error)
    }, [error])

    return (
        // `pe-10` only when dismissible, so the control cannot overlap the message it belongs to; the
        // Alert is already `relative`, and the button is positioned out of the grid flow so the
        // primitive's own two-column layout is untouched.
        <Alert
            theme={messages[0]?.indicator === 'yellow' ? 'amber' : "red"}
            className={cn(onDismiss && 'pe-10', className)}
            {...props}>
            <AlertCircle />
            <AlertTitle>{overrideHeading ?? parseHeading(messages[0])}</AlertTitle>
            <AlertDescription>
                {messages.map((m, i) => {
                    return <MarkdownRenderer content={m.message} key={i} />
                })}
            </AlertDescription>
            {onDismiss && <Button
                type="button"
                isIconButton
                variant="ghost"
                size="sm"
                className="absolute top-2 end-2"
                onClick={onDismiss}
                // Named distinctly from the shared error DIALOG's "Dismiss" action: both can be on
                // screen at once for one failure, and two controls answering to the same name is
                // ambiguous to anyone driving the page by name rather than by sight.
                aria-label={_("Dismiss message")}
                title={_("Dismiss message")}>
                <XIcon />
            </Button>}
        </Alert>
    )
}

export default ErrorBanner
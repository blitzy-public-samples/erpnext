import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import _ from '@/lib/translate'
import { TriangleAlertIcon } from 'lucide-react'

/**
 * What the reviewer sees if the whole application fails to render.
 *
 * This is the fallback behind the root `ErrorBoundary`, and it is the LAST resort: individual surfaces
 * that render records they did not write contain their own failures far more gracefully - see the per-row
 * boundary in the session action log - and reaching this one means nothing closer to the failure caught it.
 *
 * It says the one thing that matters after a client-side failure in an accounting product: that nothing
 * was posted BY the failure. A render error happens after the server has already answered, so the books
 * are whatever the server made them - and a reviewer staring at a broken screen has no way to know that
 * unless it is said. Reloading is the only recovery a torn-down React tree has, so it is offered directly
 * rather than left to the browser's own control.
 */
const AppRenderFailure = () => (
	<div className='p-4' role='alert'>
		<Empty>
			<EmptyMedia>
				<TriangleAlertIcon />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>{_("Banking could not be displayed")}</EmptyTitle>
				<EmptyDescription>
					{_("Something went wrong while drawing this page. Nothing was posted to your books by this failure - reloading will start again from what the server holds.")}
				</EmptyDescription>
			</EmptyHeader>
			<Button size='sm' variant='solid' theme='gray' onClick={() => window.location.reload()}>
				{_("Reload")}
			</Button>
		</Empty>
	</div>
)

export default AppRenderFailure

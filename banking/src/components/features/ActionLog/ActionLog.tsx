import { Button } from '@/components/ui/button'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import _ from '@/lib/translate'
import { HistoryIcon } from 'lucide-react'
import { useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import ActionLogDialog from './ActionLogDialog'

const ActionLog = () => {
	const [isOpen, setIsOpen] = useState(false)

	useHotkeys('meta+z', () => {
		setIsOpen(true)
	}, {
		enabled: true,
		enableOnFormTags: false,
		preventDefault: true
	})

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<DialogTrigger asChild>
						{/*
						 * Named explicitly. It is an icon-only control, and the tooltip beside it announces
						 * nothing until it is open - so without this the way IN to the audit trail, and to the
						 * only undo the SPA offers, is an unnamed button.
						 */}
						<Button variant={'outline'} isIconButton size='md' aria-label={_("Reconciliation History")}>
							<HistoryIcon />
						</Button>
					</DialogTrigger>
				</TooltipTrigger>
				<TooltipContent>
					{_("Reconciliation History")}
				</TooltipContent>
			</Tooltip>
			{isOpen && (
				<ActionLogDialog onClose={() => setIsOpen(false)} />
			)}
		</Dialog>
	)
}

export default ActionLog

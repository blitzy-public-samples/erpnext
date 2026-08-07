import { lazy, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { FrappeProvider } from 'frappe-react-sdk'
import { Toaster } from '@/components/ui/sonner'
import BankReconciliation from '@/pages/BankReconciliation'
import BankStatementImporterContainer from '@/pages/BankStatementImporterContainer'
import { TooltipProvider } from './components/ui/tooltip'
import { LucideProvider } from 'lucide-react'
import { ThemeProvider } from './components/ui/theme-provider'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import AppRenderFailure from '@/components/common/AppRenderFailure'

const BankStatementImporter = lazy(() => import('@/pages/BankStatementImporter'))
const ViewBankStatementImportLog = lazy(() => import('@/pages/ViewBankStatementImportLog'))

function App() {
	useEffect(() => {
		// Check if user is logged in by checking the Cookie "user_id"
		// In Frappe, unauthenticated users are "Guest"
		const userId = document.cookie?.split('; ').find(row => row.startsWith('user_id='))?.split('=')[1]?.trim()
		const isLoggedIn = userId !== 'Guest'

		if (!isLoggedIn) {
			if (import.meta.env.DEV) {
				return
			}
			// Redirect to Frappe login page
			window.location.href = '/login?redirect-to=/banking'
			return
		}
	}, [])

	return (
		<LucideProvider
			strokeWidth={1.5}
		>
			<TooltipProvider>
				<FrappeProvider
					swrConfig={{
						errorRetryCount: 2
					}}
					socketPort={import.meta.env.VITE_SOCKET_PORT}
					siteName={window.frappe?.boot?.sitename ?? import.meta.env.VITE_SITE_NAME}>
					<ThemeProvider
						defaultTheme={window.frappe?.boot?.desk_theme ?? "Automatic"}
					>
						{window.frappe?.boot?.user?.name && window.frappe?.boot?.user?.name !== 'Guest' &&
							/*
							 * Last-resort containment. Individual surfaces that render records they did not
							 * write contain their own failures far more gracefully - see the per-row boundary
							 * in the session action log - but nothing else stands between an unforeseen render
							 * error anywhere in the tree and React tearing the whole document down to a blank
							 * page with no explanation and no way forward but the browser's reload button.
							 */
							<ErrorBoundary label="Banking app root" fallback={<AppRenderFailure />}>
								<BrowserRouter basename={import.meta.env.VITE_BASE_NAME ? `/${import.meta.env.VITE_BASE_NAME}` : ''}>
									<Routes>
										<Route index element={<BankReconciliation />} />
										<Route path="/statement-importer" element={<BankStatementImporterContainer />}>
											<Route index element={<BankStatementImporter />} />
											<Route path=":id" element={<ViewBankStatementImportLog />} />
										</Route>
										{/* `replace` REPLACES the unmatched entry instead of pushing over it. Pushing left
										    the bogus URL on the stack, so Back returned to it and this same route
										    immediately pushed the redirect again - one unmatched URL cost three history
										    entries and the reviewer could no longer leave the app with Back. */}
										<Route path="*" element={<Navigate to="/" replace />} />
									</Routes>
								</BrowserRouter>
							</ErrorBoundary>
						}
						<Toaster richColors />
					</ThemeProvider>
				</FrappeProvider>
			</TooltipProvider>
		</LucideProvider>
	)
}

export default App

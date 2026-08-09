import { Suspense } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbList } from '@/components/ui/breadcrumb'
import _ from '@/lib/translate'
import { HomeIcon, Loader2Icon } from 'lucide-react'
import { Link, Outlet } from 'react-router'
import { MainContent } from '@/components/common/PageShell'

const BankStatementImporterContainer = () => {
    // Matches the workbench cap so navigating between the two does not shift the content box.
    return (
        <div className="mx-auto flex w-full max-w-[96rem] flex-col pt-1.5">
            {/*
                A `header` element, OUTSIDE the `main` landmark below. `header` earns the `banner` role
                only when it is not nested inside `main`, and while `main` wrapped the whole route there
                was no banner landmark and the skip link had nothing to skip - the first Tab after
                activating it was still this breadcrumb.
            */}
            <header className="flex gap-2 items-baseline p-4">
                    <Breadcrumb>
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                {/*
                                    Named, because this is the FIRST link in the tab order on every route
                                    and it contains nothing but an icon - so it announced itself as a bare
                                    "link" with no destination, and it navigates away from the app entirely.
                                    The glyph is hidden from assistive technology so the name is not read twice.
                                */}
                                <a href="/desk" className="text-ink-gray-7" aria-label={_("ERPNext home")}>
                                    <HomeIcon size={16} aria-hidden="true" />
                                </a>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbLink asChild>
                                    <Link to="/">
                                        {_("Banking")}
                                    </Link>
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>{_("Import Bank Statement")}</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
            </header>
            <MainContent title={_("Import Bank Statement")} className="flex flex-1 flex-col">
                <Suspense fallback={
                    <div className="flex flex-1 items-center justify-center p-16">
                        <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
                        <span className="sr-only">{_("Loading")}</span>
                    </div>
                }>
                    <Outlet />
                </Suspense>
            </MainContent>
        </div>
    )
}

export default BankStatementImporterContainer

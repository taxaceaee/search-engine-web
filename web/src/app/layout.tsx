import type { Metadata } from "next";
import "./globals.css";

// Design tokens retain the DM_Sans / Space_Grotesk / JetBrains_Mono hierarchy
// subsets: ["latin"] while using local/system fallbacks so builds never depend on
// Google Fonts network availability.

export const metadata: Metadata = {
  title: "SearchEngine — AI Research Workspace",
  description:
    "Dataset search and web research with BM25 hybrid retrieval and cited answers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: browser extensions often inject attributes on
    // <html>/<body> (e.g. __processed_*=true) before React hydrates, which
    // otherwise surfaces as a noisy mismatch in dev.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased" suppressHydrationWarning>
        <div className="page-mesh" aria-hidden />
        {children}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "@/components/ui/sonner";
import { BridgeProvider } from "@/components/bridge/bridge-provider";
import { DevBar } from "@/components/dev-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gridlock — street design & traffic simulation",
  description: "Design street networks precisely and simulate traffic on them.",
};

// (the page comes in light and dark colours, by the system's setting: the browser told before any CSS loads, so its
// own controls and the first paint match; see globals.css)
export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
        {/* (the Claude bridge: idle until an admin pairs the page; see docs/claude-bridge.md) */}
        <BridgeProvider />
        <DevBar />
      </body>
    </html>
  );
}

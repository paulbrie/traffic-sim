import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "@/components/ui/sonner";
import { BridgeProvider } from "@/components/bridge/bridge-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gridlock — street design & traffic simulation",
  description: "Design street networks precisely and simulate traffic on them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
        {/* (the Claude bridge: idle until an admin pairs the page; see docs/claude-bridge.md) */}
        <BridgeProvider />
      </body>
    </html>
  );
}

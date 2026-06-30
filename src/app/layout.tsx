import type { Metadata } from "next";
import BootScreen from "@/components/boot-screen";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "xiao.sh",
  description: "Minimal portfolio with AI project search",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${mono.variable} antialiased`}>
        {/* No-JS fallback: the boot overlay never lifts without JS, so hide it. */}
        <noscript>
          {/* eslint-disable-next-line react/no-danger */}
          <style dangerouslySetInnerHTML={{ __html: ".tui-boot{display:none!important}" }} />
        </noscript>
        <BootScreen />
        <div className="crt" aria-hidden="true" />
        <div className="app-shell">{children}</div>
      </body>
    </html>
  );
}

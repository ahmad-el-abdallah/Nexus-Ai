import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NEXUS AI",
  description: "Your Corporation. Your AI Workforce.",
};

export const viewport: Viewport = {
  themeColor: "#060a18",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        <div className="nx-backdrop" aria-hidden />
        {children}
      </body>
    </html>
  );
}

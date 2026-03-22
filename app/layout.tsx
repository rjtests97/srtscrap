import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shiprocket Order Scrapper — by RahulJ",
  description: "Competitive intelligence for Shiprocket brands",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}

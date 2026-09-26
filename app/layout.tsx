import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sunday Room — Your game day, your way",
  description: "Your personal NFL and college football viewing room. Follow scores, build a multiview, and stay close to the action.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  other: {
    "darkreader-lock": "true",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}

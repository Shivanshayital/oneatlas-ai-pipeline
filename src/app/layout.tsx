import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OneAtlas AI Pipeline",
  description: "Live AI pipeline execution and observability dashboard.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

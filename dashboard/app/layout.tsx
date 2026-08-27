import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "Garnly dashboard" };

const NAV = [
  ["/", "Oversikt"],
  ["/ordrer", "Ordrer"],
  ["/umatchet", "Umatchet"],
  ["/lager", "Lager"],
  ["/synk", "Synk"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no">
      <body>
        <header>
          <span className="logo">Garnly garnbutikk</span>
          <nav>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

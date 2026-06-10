import type { Metadata } from "next";
import "./globals.css";
import ChatWidget from "./ChatWidget";

export const metadata: Metadata = {
  title: "Kindling",
  description: "Self-hosted personal finance",
};

// Set the theme before first paint (localStorage choice, else OS preference)
// so neither palette flashes. Kept tiny and inline on purpose.
const themeBoot = `try{var t=localStorage.getItem("kindling-theme")||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        {children}
        <ChatWidget />
      </body>
    </html>
  );
}

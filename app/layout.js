// The app shell. Every page renders inside this.
import './globals.css';

export const metadata = {
  title: 'Flux',
  description: 'A double-entry ledger that is provably correct under concurrent load.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a href="/" className="brand">
            <span className="brand-mark">F</span>
            <span>Flux</span>
          </a>
          <span className="brand-tagline">balances are derived, never stored</span>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}

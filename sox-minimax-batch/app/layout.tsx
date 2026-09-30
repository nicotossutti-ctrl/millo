import './styles.css';

export const metadata = {
  title: 'SOX · Videos 360°',
  description: 'Videos de producto SOX desde Google Drive con MiniMax H3',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}

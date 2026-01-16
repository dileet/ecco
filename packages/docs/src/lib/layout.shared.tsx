import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img src="/ecco.png" alt="Ecco" width={24} height={24} />
          <span>Ecco</span>
        </>
      ),
    },
  };
}

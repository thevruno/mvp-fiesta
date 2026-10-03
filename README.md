# mvp-fiesta

MVP de una app para organizar fiestas. Prueba de concepto sin login ni base de datos: los datos viven en el navegador (localStorage), así que se puede probar el flujo completo sin registrarse.

## Stack

- [Next.js](https://nextjs.org) (App Router) + React 19 + TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4
- Deploy en [Vercel](https://vercel.com): cada PR genera una URL de preview

## Correr en local

```bash
npm install
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000).

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción |
| `npm run start` | Sirve el build de producción |
| `npm run lint` | ESLint |

## Deploy

- **Preview por PR:** Vercel crea una URL por cada pull request.
- **Producción:** se publica al mergear a `main`.

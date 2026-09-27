# Vō Studio — sitio web

Sitio institucional de **Vō Studio**, agencia de marketing y partner estratégico.
Estética editorial de grilla suiza (inspirada en la plantilla Das Studio de Framer) con profundidad 3D:
la "ō." del logo es una escultura en WebGL que sigue el mouse y se desarma con el scroll.

## Stack

- [Vite](https://vite.dev): desarrollo y build estático.
- [Three.js](https://threejs.org): escultura 3D de la portada (`src/scene.js`).
- [GSAP + ScrollTrigger](https://gsap.com): intro, parallax por capas y animaciones con scroll.
- [Lenis](https://lenis.darkroom.engineering): scroll suave.
- Tipografías de Google Fonts: Bodoni Moda (display, eco del logo), Schibsted Grotesk (texto), IBM Plex Mono (etiquetas).

## Uso

```bash
npm install
npm run dev      # servidor local con recarga
npm run build    # genera /dist para publicar
npm run preview  # sirve /dist localmente
```

`/dist` se puede subir a Vercel, Netlify, Cloudflare Pages o cualquier hosting estático.

## Estructura

```
index.html        Contenido y estructura de todas las secciones
src/styles.css    Sistema visual (tokens de color, tipografía, grilla) y estilos
src/main.js       Scroll suave, navegación, animaciones, acordeón, cursor y formulario
src/scene.js      Escena 3D de la portada
```

## Pendientes antes de publicar

- **Proyectos**: las cuatro tarjetas de `#proyectos` son ejemplos con arte generado en CSS.
  Reemplazar por casos reales (fotos o video dentro de `.card__media`).
- **Formulario**: agregar `data-endpoint="https://..."` al `<form data-form>` (Formspree, Basin o un webhook propio).
  Sin endpoint, el formulario valida pero avisa que no está conectado.
- **Redes**: completar los links de Instagram, LinkedIn y Behance en el footer (tienen `data-todo`).
- **Logo**: el wordmark está recreado con Bodoni Moda. Si hay SVG del logo original, reemplazar `.wordmark`.
- **Textos**: revisar titulares, servicios, plazos del método y el estado "Agenda abierta · Q1 2027".
- **SEO**: agregar imagen para compartir (`og:image`), favicon y dominio definitivo.

## Accesibilidad y rendimiento

- Respeta `prefers-reduced-motion`: sin scroll suave, sin parallax y escultura quieta.
- En celulares la escena 3D baja resolución y geometría. Se pausa cuando la portada sale de pantalla.
- Si WebGL no está disponible se muestra una "ō" tipográfica en su lugar.

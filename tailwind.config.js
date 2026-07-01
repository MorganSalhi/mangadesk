/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Tokens sémantiques pilotés par variables CSS (cf. src/index.css :
        // valeurs claires sous :root, sombres sous .dark). Format « canaux RGB »
        // pour conserver le support des opacités Tailwind (bg-fill/10, etc.).
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          sunken: "rgb(var(--surface-sunken) / <alpha-value>)",
        },
        // Texte : 4 niveaux de hiérarchie (primaire → effacé).
        content: {
          DEFAULT: "rgb(var(--content) / <alpha-value>)",
          2: "rgb(var(--content-2) / <alpha-value>)",
          3: "rgb(var(--content-3) / <alpha-value>)",
          4: "rgb(var(--content-4) / <alpha-value>)",
        },
        // Bordures (line) et remplissages subtils / hover (fill) : base claire ou
        // sombre selon le thème, l'opacité (/5, /10…) restant gérée par Tailwind.
        line: "rgb(var(--line) / <alpha-value>)",
        fill: "rgb(var(--fill) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};

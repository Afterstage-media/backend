(() => {
  const payload = () => ({
    title: document.title,
    text: document.querySelector('meta[name="description"]')?.content || document.title,
    url: window.location.href,
  });

  document.querySelectorAll("[data-share]").forEach((button) =>
    button.addEventListener("click", async () => {
      const value = payload();
      try {
        if (navigator.share) await navigator.share(value);
        else if (navigator.clipboard) {
          await navigator.clipboard.writeText(value.url);
          button.textContent = "Enlace copiado";
        } else window.prompt("Copiá este enlace", value.url);
      } catch (error) {
        if (error?.name !== "AbortError") window.prompt("Copiá este enlace", value.url);
      }
    }),
  );

  document.querySelectorAll("[data-share-instagram]").forEach((button) =>
    button.addEventListener("click", async () => {
      const value = payload();
      const title = button.dataset.share || document.querySelector("h1")?.textContent || document.title;
      const instagramText = `${title}\n\n${value.text}\n${value.url}`;
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(instagramText);
          button.textContent = "Texto copiado";
        } else window.prompt("Copiá este texto para Instagram", instagramText);
      } catch (error) {
        if (error?.name !== "AbortError") window.prompt("Copiá este texto para Instagram", instagramText);
      }
    }),
  );
})();

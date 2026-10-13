(() => {
  const payload = () => ({ title: document.title, text: document.querySelector('meta[name="description"]')?.content || document.title, url: window.location.href });
  document.querySelectorAll('[data-share]').forEach((button) => button.addEventListener('click', async () => {
    const value = payload();
    try { if (navigator.share) await navigator.share(value); else if (navigator.clipboard) { await navigator.clipboard.writeText(value.url); button.textContent = 'Enlace copiado'; } else window.prompt('Copiá este enlace', value.url); }
    catch (error) { if (error?.name !== 'AbortError') window.prompt('Copiá este enlace', value.url); }
  }));
  document.querySelectorAll('[data-share-instagram]').forEach((button) => button.addEventListener('click', async () => {
    const value = payload();
    try { if (navigator.share) await navigator.share({ ...value, text: `${value.text}\n${value.url}` }); else if (navigator.clipboard) { await navigator.clipboard.writeText(value.url); button.textContent = 'Enlace copiado'; } else window.prompt('Copiá este enlace para Instagram', value.url); }
    catch (error) { if (error?.name !== 'AbortError') window.prompt('Copiá este enlace para Instagram', value.url); }
  }));
})();

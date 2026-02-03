document.addEventListener("DOMContentLoaded", () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  const form = document.querySelector("form[data-contact='form']");
  if (!form) return;

  const submitBtn = form.querySelector("button[type='submit']");

  const showMessage = (text, type = "success") => {
    let banner = form.querySelector(".contact-message");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "contact-message";
      banner.style.marginBottom = "1rem";
      banner.style.padding = "0.75rem 1rem";
      banner.style.borderRadius = "0.75rem";
      banner.style.fontSize = "0.95rem";
      form.prepend(banner);
    }
    banner.style.background = type === "success" ? "#ecfdf3" : "#fef2f2";
    banner.style.color = type === "success" ? "#166534" : "#991b1b";
    banner.style.border = type === "success" ? "1px solid #bbf7d0" : "1px solid #fecaca";
    banner.textContent = text;
  };

  const setLoading = (loading) => {
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    submitBtn.style.opacity = loading ? "0.7" : "1";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = form.querySelector("input[name='name']").value.trim();
    const email = form.querySelector("input[name='email']").value.trim();
    const subject = form.querySelector("input[name='subject']").value.trim();
    const message = form.querySelector("textarea[name='message']").value.trim();

    if (!name || !email || !subject || !message) {
      showMessage("Please fill all fields.", "error");
      return;
    }

    setLoading(true);

    try {
      const data = await api.apiFetch("/contact", {
        method: "POST",
        body: JSON.stringify({ name, email, subject, message })
      });

      showMessage(data.message || "Message sent successfully.");
      form.reset();
    } catch (err) {
      showMessage(err.message || "Failed to send message.", "error");
    } finally {
      setLoading(false);
    }
  });
});

document.addEventListener("DOMContentLoaded", () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  const handleAuthRoute = (event) => {
    const token = api.getToken();
    if (token) {
      event.preventDefault();
      window.location.href = "/learning/";
    }
  };

  document.querySelectorAll("[data-auth-route]").forEach((el) => {
    el.addEventListener("click", handleAuthRoute);
  });

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const plan = button.getAttribute("data-plan");

      if (!api.getToken()) {
        window.location.href = "/signup/";
        return;
      }

      try {
        await api.apiFetch("/subscribe", {
          method: "POST",
          body: JSON.stringify({ plan })
        });
        window.location.href = "/learning/";
      } catch (err) {
        alert(err.message || "Unable to activate subscription.");
      }
    });
  });
});

document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  const logoutLinks = document.querySelectorAll(".logout-link");
  logoutLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      api.clearToken();
      window.location.href = "/login/";
    });
  });

  if (!api.requireAuth()) {
    return;
  }

  try {
    const data = await api.getProfile();
    const user = data.user;

    const heading = document.querySelector(".dashboard-header h1");
    if (heading && user && user.name) {
      heading.textContent = `Welcome back, ${user.name}! 👋`;
    }

    const initialsBadge = document.querySelector(".dashboard-header [data-initials]");
    if (initialsBadge && user && user.name) {
      const initials = user.name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
      initialsBadge.textContent = initials || "U";
    }
  } catch (err) {
    // Silently fail - don't redirect on profile fetch error
    // User badge will show default "U"
    console.debug("Profile fetch failed (non-critical):", err.message);
  }
});

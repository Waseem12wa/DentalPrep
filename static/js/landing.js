document.addEventListener("DOMContentLoaded", () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  // Show Dashboard link if logged in
  const token = api.getToken();
  const navDashboard = document.getElementById("nav-dashboard");
  if (token && navDashboard) {
    navDashboard.classList.remove("hidden");
  }

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
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const plan = button.getAttribute("data-plan");

      // Map 'mbbs'/'bds' to 'annual' for now or keep distinct if backend supports it
      // Based on pricing section, plans are trial, monthly, annual.
      // The MBBS/BDS cards in index.html (lines 494/529) use 'mbbs'/'bds' but have Annual features.
      // Let's map them to 'annual' for simplicity in this demo, or pass them as is.
      // Passing as is allows future differentiation.

      let checkoutPlan = plan;
      if (plan === 'mbbs' || plan === 'bds') checkoutPlan = 'annual';

      if (!api.getToken()) {
        // If not logged in, go to signup with redirect intent
        // Simplified: go to signup
        window.location.href = "/signup/";
        return;
      }

      window.location.href = `/checkout/?plan=${checkoutPlan}`;
    });
  });
});

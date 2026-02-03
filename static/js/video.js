document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  if (!api.requireAuth()) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const videoId = params.get("id");

  const titleEl = document.getElementById("video-title");
  const metaEl = document.getElementById("video-meta");
  const completeBtn = document.getElementById("mark-complete");

  if (!videoId) {
    if (titleEl) titleEl.textContent = "Video not found";
    if (metaEl) metaEl.textContent = "Missing video id";
    if (completeBtn) completeBtn.disabled = true;
    return;
  }

  try {
    const { video } = await api.apiFetch(`/videos/${videoId}`);
    if (titleEl) titleEl.textContent = video.title;
    if (metaEl) {
      metaEl.innerHTML = `
        <span><i class="fas fa-book"></i> ${video.courseId}</span>
        <span><i class="fas fa-play"></i> YouTube</span>
      `;
    }

    const player = document.getElementById("video-player");
    if (player && video.videoUrl) {
      const youtubeIdMatch = video.videoUrl.match(/v=([^&]+)/);
      const youtubeId = youtubeIdMatch ? youtubeIdMatch[1] : null;
      if (youtubeId) {
        player.innerHTML = `
          <iframe
            width="100%"
            height="320"
            src="https://www.youtube.com/embed/${youtubeId}"
            title="${video.title}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            style="border-radius: 1rem;">
          </iframe>
        `;
      }
    }

    if (completeBtn) {
      completeBtn.addEventListener("click", async () => {
        try {
          await api.apiFetch("/progress", {
            method: "POST",
            body: JSON.stringify({
              courseId: video.courseId,
              videoId: video.id,
              completed: true,
              score: 0
            })
          });
          completeBtn.textContent = "Completed";
          completeBtn.disabled = true;
        } catch (err) {
          alert(err.message || "Unable to save progress.");
        }
      });
    }
  } catch (err) {
    if (titleEl) titleEl.textContent = "Video not found";
    if (metaEl) metaEl.textContent = err.message || "Unable to load video";
  }
});

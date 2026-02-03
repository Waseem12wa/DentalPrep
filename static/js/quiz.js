document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  if (!api.requireAuth()) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const quizId = params.get("id");

  const titleEl = document.getElementById("quiz-title");
  const metaEl = document.getElementById("quiz-meta");
  const formEl = document.getElementById("quiz-form");
  const submitBtn = document.getElementById("submit-quiz");
  const resultEl = document.getElementById("quiz-result");

  if (!quizId) {
    if (titleEl) titleEl.textContent = "Quiz not found";
    if (metaEl) metaEl.textContent = "Missing quiz id";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  let quiz = null;

  const showResult = (text, type = "success") => {
    if (!resultEl) return;
    resultEl.innerHTML = `<div class="result-banner" style="background: ${
      type === "success" ? "#ecfdf3" : "#fef2f2"
    }; color: ${type === "success" ? "#166534" : "#991b1b"}; border: 1px solid ${
      type === "success" ? "#bbf7d0" : "#fecaca"
    }">${text}</div>`;
  };

  try {
    const data = await api.apiFetch(`/quizzes/${quizId}`);
    quiz = data.quiz;

    if (titleEl) titleEl.textContent = quiz.title;
    if (metaEl) metaEl.textContent = `${quiz.questions.length} questions`;

    if (formEl) {
      formEl.innerHTML = "";
      quiz.questions.forEach((question, index) => {
        const card = document.createElement("div");
        card.className = "question-card";
        card.innerHTML = `
          <div style="font-weight: 700;">${index + 1}. ${question.question}</div>
        `;
        question.options.forEach((option, optionIndex) => {
          const optionId = `${question.id}-${optionIndex}`;
          const wrapper = document.createElement("label");
          wrapper.className = "option";
          wrapper.innerHTML = `
            <input type="radio" name="${question.id}" value="${optionIndex}" id="${optionId}">
            <span>${option}</span>
          `;
          card.appendChild(wrapper);
        });
        formEl.appendChild(card);
      });
    }
  } catch (err) {
    if (titleEl) titleEl.textContent = "Quiz not found";
    if (metaEl) metaEl.textContent = err.message || "Unable to load quiz";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (!quiz) return;

      let correct = 0;
      quiz.questions.forEach((question) => {
        const selected = formEl.querySelector(`input[name='${question.id}']:checked`);
        if (selected && question.options[Number(selected.value)] === question.correctAnswer) {
          correct += 1;
        }
      });

      const score = Math.round((correct / quiz.questions.length) * 100);
      showResult(`You scored ${score}% (${correct}/${quiz.questions.length} correct)`);

      try {
        await api.apiFetch("/progress", {
          method: "POST",
          body: JSON.stringify({
            courseId: quiz.courseId,
            videoId: quiz.id,
            completed: true,
            score
          })
        });
      } catch (err) {
        showResult(err.message || "Unable to save score.", "error");
      }
    });
  }
});

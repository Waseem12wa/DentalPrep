// Enhanced JavaScript for modern UX
document.addEventListener('DOMContentLoaded', function() {
    // Mobile menu functionality with improved animations
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const navMenu = document.getElementById('nav-menu');
    const overlay = document.getElementById('overlay');
    const body = document.body;

    function toggleMobileMenu() {
        const isOpen = navMenu.classList.contains('show');

        navMenu.classList.toggle('show');
        overlay.classList.toggle('show');

        // Prevent body scroll when menu is open
        if (!isOpen) {
            body.style.overflow = 'hidden';
        } else {
            body.style.overflow = '';
        }

        // Toggle hamburger icon with smooth transition
        const icon = mobileMenuBtn.querySelector('i');
        if (navMenu.classList.contains('show')) {
            icon.style.transform = 'rotate(90deg)';
            setTimeout(() => {
                icon.className = 'fas fa-times';
                icon.style.transform = 'rotate(0deg)';
            }, 150);
        } else {
            icon.style.transform = 'rotate(90deg)';
            setTimeout(() => {
                icon.className = 'fas fa-bars';
                icon.style.transform = 'rotate(0deg)';
            }, 150);
        }
    }

    mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    overlay.addEventListener('click', toggleMobileMenu);

    // Close menu when clicking on nav links
    navMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 767) {
                toggleMobileMenu();
            }
        });
    });

    // Enhanced scroll animations with Intersection Observer
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                // Add stagger effect for multiple elements
                setTimeout(() => {
                    entry.target.classList.add('animate');
                }, index * 100);
            }
        });
    }, observerOptions);

    // Observe all scroll-animate elements
    document.querySelectorAll('.scroll-animate').forEach(el => {
        observer.observe(el);
    });

    // Enhanced header background on scroll with performance optimization
    let ticking = false;

    function updateHeader() {
        const header = document.querySelector('header');
        const scrollY = window.scrollY;

        if (scrollY > 50) {
            header.style.background = 'rgba(255, 255, 255, 0.95)';
            header.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.1)';
            header.style.borderBottomColor = 'rgba(0, 0, 0, 0.1)';
        } else {
            header.style.background = 'rgba(255, 255, 255, 0.85)';
            header.style.boxShadow = '0 2px 20px rgba(0, 0, 0, 0.05)';
            header.style.borderBottomColor = 'rgba(0, 0, 0, 0.08)';
        }

        ticking = false;
    }

    function requestHeaderUpdate() {
        if (!ticking) {
            requestAnimationFrame(updateHeader);
            ticking = true;
        }
    }

    window.addEventListener('scroll', requestHeaderUpdate, {
        passive: true
    });

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                const headerHeight = document.querySelector('header').offsetHeight;
                const targetPosition = target.offsetTop - headerHeight - 20;

                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // Enhanced button interactions with loading states
    function addLoadingState(btn, originalText, duration = 2000) {
        if (btn.disabled) return;

        const spinner = '<i class="loading" aria-hidden="true"></i>';
        btn.innerHTML = `${spinner} Loading...`;
        btn.disabled = true;
        btn.style.pointerEvents = 'none';

        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.pointerEvents = '';
        }, duration);
    }

    // Apply loading states to CTA buttons
    document.querySelectorAll('.cta-btn, .subscribe-btn, .getting-started-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            if (this.tagName === 'BUTTON') {
                e.preventDefault();
                const originalText = this.innerHTML;
                addLoadingState(this, originalText);

                // Simulate navigation after loading
                setTimeout(() => {
                    if (this.getAttribute('onclick')) {
                        eval(this.getAttribute('onclick'));
                    }
                }, 2000);
            }
        });
    });

    // Parallax effect for hero section (performance optimized)
    const hero = document.querySelector('.hero');
    let heroTicking = false;

    function updateParallax() {
        const scrolled = window.pageYOffset;
        const parallax = hero.querySelector('.hero-content');
        const speed = 0.5;

        if (parallax && scrolled < hero.offsetHeight) {
            parallax.style.transform = `translateY(${scrolled * speed}px)`;
        }

        heroTicking = false;
    }

    function requestParallaxUpdate() {
        if (!heroTicking && window.innerWidth > 768) {
            requestAnimationFrame(updateParallax);
            heroTicking = true;
        }
    }

    window.addEventListener('scroll', requestParallaxUpdate, {
        passive: true
    });

    // Enhanced form validation feedback
    document.querySelectorAll('input, textarea').forEach(input => {
        input.addEventListener('focus', function() {
            this.style.borderColor = 'var(--primary-color)';
            this.style.boxShadow = '0 0 0 3px rgba(220, 20, 60, 0.1)';
        });

        input.addEventListener('blur', function() {
            this.style.borderColor = '';
            this.style.boxShadow = '';
        });
    });

    // Accessibility improvements
    // Announce page changes for screen readers
    const pageTitle = document.title;
    const announcement = document.createElement('div');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    announcement.className = 'sr-only';
    announcement.textContent = `Page loaded: ${pageTitle}`;
    document.body.appendChild(announcement);

    // Keyboard navigation enhancement
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && navMenu.classList.contains('show')) {
            toggleMobileMenu();
        }
    });

    // Performance optimization: Lazy load images
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                    }
                    img.classList.remove('lazy');
                    imageObserver.unobserve(img);
                }
            });
        });

        document.querySelectorAll('img[data-src]').forEach(img => {
            imageObserver.observe(img);
        });
    }

    // Add focus visible polyfill for better accessibility
    function addFocusVisiblePolyfill() {
        let hadKeyboardEvent = false;

        document.addEventListener('mousedown', () => {
            hadKeyboardEvent = false;
        });

        document.addEventListener('keydown', (e) => {
            if (e.metaKey || e.altKey || e.ctrlKey) {
                return;
            }
            hadKeyboardEvent = true;
        });

        document.addEventListener('focus', (e) => {
            if (hadKeyboardEvent || e.target.matches(':focus-visible')) {
                e.target.classList.add('focus-visible');
            }
        }, true);

        document.addEventListener('blur', (e) => {
            e.target.classList.remove('focus-visible');
        }, true);
    }

    addFocusVisiblePolyfill();

    // Initialize all enhancements
    console.log('PulsePrep: Modern UI/UX enhancements loaded successfully! 🚀');
});

// Performance monitoring (optional)
if ('performance' in window) {
    window.addEventListener('load', () => {
        const loadTime = performance.timing.loadEventEnd - performance.timing.navigationStart;
        console.log(`Page load time: ${loadTime}ms`);
    });
}

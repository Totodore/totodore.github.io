// Linked images keep their link behavior, and spoilers need their click to
// reveal on touch devices.
const zoomable = document.querySelectorAll(
	"main img:not(.no-hover, .emoji, .spoiler, a img)"
);

if (zoomable.length > 0) {
	const dialog = document.createElement("dialog");
	dialog.id = "image-zoom";

	const zoomed = document.createElement("img");
	// Opts out of the theme's hover scale and zoom-in cursor.
	zoomed.className = "no-hover";

	dialog.append(zoomed);
	document.body.append(dialog);

	// A click on the backdrop targets the dialog itself, so this closes on
	// any click.
	dialog.addEventListener("click", () => dialog.close());

	zoomable.forEach((image) => {
		image.addEventListener("click", () => {
			zoomed.src = image.currentSrc || image.src;
			zoomed.alt = image.alt;
			dialog.showModal();
		});
	});
}

import {onBeforeUnmount, onMounted, ref} from "vue";
import eventbus from "../eventbus";

/**
 * A button that opens a context menu: `expanded` for its `aria-expanded`,
 * true from `opened()` until ContextMenu.vue says the menu closed.
 */
export default function useMenuTrigger() {
	const expanded = ref(false);

	const closed = () => {
		expanded.value = false;
	};

	onMounted(() => eventbus.on("contextmenu:closed", closed));
	onBeforeUnmount(() => eventbus.off("contextmenu:closed", closed));

	const opened = () => {
		expanded.value = true;
	};

	return {expanded, opened};
}

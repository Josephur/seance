import {expect} from "chai";
import eventbus from "../../client/js/eventbus";
import {confirmMismatch} from "../../client/js/helpers/openLink";

describe("openLink (the mismatch dialog)", function () {
	it("names the real host, never the raw href with its userinfo or lookalike letters", function () {
		let text = "";
		const listener = (data: {text: string}) => (text = data.text);
		eventbus.on("confirm-dialog", listener);

		try {
			confirmMismatch("https://paypal.com@evil.example/login", "paypal.com", "evil.example");
			expect(text).to.include("evil.example");
			expect(text).to.not.include("paypal.com@");
			confirmMismatch("https://pаypal.com/login", "paypal.com", "xn--pypal-4ve.com");
			expect(text).to.include("xn--pypal-4ve.com");
			expect(text).to.not.include("pаypal");
		} finally {
			eventbus.off("confirm-dialog", listener);
		}
	});
});

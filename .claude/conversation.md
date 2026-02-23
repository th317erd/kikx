Problems (in order of priority):
1. The "Settings" page has no "back" button in the header-bar (/home/wyatt/Pictures/Screenshots/Screenshot_20260221_172008.png)
<!--
Thoughts: We really must ALWAYS have a back button here. Please also implement "window.history", so pushing the back button in the browser is the same as pushing the "back" button in the header-bar.
-->
2. The "Settings" page is completely blank... it contains no content.
<!--
Thoughts: Maybe we should make an "tests.isVisible" helper method inside JSDOM, such that this method will scane the "cssStyles" compiled styles on each element to detect if it is actually visible or not? We could also make "existence" selectors a test, yes?
-->
3. I was unable to answer all hml-prompts... not for lack of trying (/home/wyatt/Pictures/Screenshots/Screenshot_20260221_171603.png). The number slider for interovert or extrovert (an hml-prompt number slider question) was a 5 in a range of 1-10. The problem is that I didn't touch it, and so 'Submit' skipped it. Any question that has a "default answer" like this should just submit the "default answer" if the user selects nothing.
<!--
Appeared to be working great. I used another number slider that changed color when I interacted with it (love that), and DID submit its answer. So, obviously submitting an answer works, you just have a bug somewhere where the default value isn't captured.
-->
4. The "time" field type for hml-prompts is broken (/home/wyatt/Pictures/Screenshots/Screenshot_20260221_171549.png). It has a pretty nifty selector, and I liked that, but even though I selected a specific time, and it selected it properly, it was not captured (and instead was reset to nothing).
<!-- 
It works great, up until I press 'Submit'. Then it was reset, and no answer was given to the agent.
 -->
5. The scrollbars in modals are styled wrong (/home/wyatt/Pictures/Screenshots/Screenshot_20260221_171517.png). They are the browser native style. They should be the same style as all other scrollbars in the app.
<!-- 
This was working before... now it isn't.
-->
6. The "Ignore" and "Submit" buttons should be the same size as the buttons in the header-bar.
7. Color contrast is bad: (/home/wyatt/Pictures/Screenshots/Screenshot_20260221_171631.png) Let's make sure that we use WHITE text on all messages, unless a certain contrast ratio with the background says the text needs to flip/invert.
8. The username text should also have the same ratio.
9. Remove all default "system" "abilities" (the default entities themselves, only)... but do not remove the abilities system itself... We want abilities, and we will expand upon this system in the future. But all of these items/entities have always been commands or functions. Not abilities. This was a misunderstanding when we built the code at first. Let's leave the "system" tab, inside the modal, and all of that. "system" abilities will come from plugins.

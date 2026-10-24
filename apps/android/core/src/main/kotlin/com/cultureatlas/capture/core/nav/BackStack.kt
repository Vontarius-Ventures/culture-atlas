package com.cultureatlas.capture.core.nav

/**
 * The signed-in shell's navigation: four root tabs plus a stack of screens
 * pushed above them (camera, music, a card, a Similar card, a board, a result).
 * Immutable so Compose can hold it in one state value; every operation returns
 * the next stack plus the direction the screen change should animate in.
 *
 * Rules:
 * - System Back pops one screen; on an empty stack it leaves to the Feed tab
 *   first, and only then lets the activity finish ([handlesBack]).
 * - Opening a Similar card pushes, so Back walks the Similar history.
 * - Pushing the screen already on top does nothing (double taps).
 * - Re-selecting the current tab pops to its root; switching tabs clears the stack.
 * - Depth is capped; the oldest pushed screens are dropped first.
 */
data class BackStack<Tab, Route>(
    val tab: Tab,
    val home: Tab,
    val routes: List<Route> = emptyList(),
    val maxDepth: Int = DEFAULT_MAX_DEPTH,
) {
    enum class Direction { FORWARD, BACK, NONE }

    data class Step<Tab, Route>(val stack: BackStack<Tab, Route>, val direction: Direction)

    val top: Route? get() = routes.lastOrNull()
    val depth: Int get() = routes.size
    val atRoot: Boolean get() = routes.isEmpty()

    /** Whether Back is handled in-app (false: let the system close the activity). */
    val handlesBack: Boolean get() = routes.isNotEmpty() || tab != home

    fun push(route: Route): Step<Tab, Route> {
        if (top == route) return Step(this, Direction.NONE)
        val next = (routes + route).let { if (it.size > maxDepth) it.drop(it.size - maxDepth) else it }
        return Step(copy(routes = next), Direction.FORWARD)
    }

    /** Replaces the top screen (e.g. camera → glasses' "Use this camera"). */
    fun replaceTop(route: Route): Step<Tab, Route> {
        if (routes.isEmpty()) return push(route)
        if (top == route) return Step(this, Direction.NONE)
        return Step(copy(routes = routes.dropLast(1) + route), Direction.FORWARD)
    }

    fun back(): Step<Tab, Route> = when {
        routes.isNotEmpty() -> Step(copy(routes = routes.dropLast(1)), Direction.BACK)
        tab != home -> Step(copy(tab = home), Direction.BACK)
        else -> Step(this, Direction.NONE)
    }

    fun popToRoot(): Step<Tab, Route> =
        if (routes.isEmpty()) Step(this, Direction.NONE) else Step(copy(routes = emptyList()), Direction.BACK)

    fun selectTab(next: Tab): Step<Tab, Route> = when {
        next == tab && routes.isEmpty() -> Step(this, Direction.NONE)
        next == tab -> popToRoot()
        else -> Step(copy(tab = next, routes = emptyList()), Direction.NONE)
    }

    /** Removes every screen matching [predicate] (e.g. a deleted board), keeping the rest in order. */
    fun removeAll(predicate: (Route) -> Boolean): Step<Tab, Route> {
        val next = routes.filterNot(predicate)
        return if (next.size == routes.size) Step(this, Direction.NONE) else Step(copy(routes = next), Direction.BACK)
    }

    companion object {
        const val DEFAULT_MAX_DEPTH = 24
    }
}

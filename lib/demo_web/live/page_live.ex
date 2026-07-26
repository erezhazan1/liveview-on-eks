defmodule DemoWeb.PageLive do
  use DemoWeb, :live_view

  # `live_dashboard_path` only exists when the LiveDashboard route is registered, which
  # router.ex does only in dev/test. This mirrors the app's own root layout
  # (lib/demo_web/templates/layout/root.html.heex + layout_view.ex): guard the link with
  # function_exported?/3 at runtime (Mix is absent in a release, so a compile-time env
  # check can't be used here) and silence the prod "undefined" compile warning the same
  # way layout_view.ex does. Without this, a prod release 500s on the homepage.
  @compile {:no_warn_undefined, {Routes, :live_dashboard_path, 2}}

  def render(assigns) do
    ~H"""
    <section class="phx-hero">
      <h2><%= gettext "Welcome to %{name}!", name: "Phoenix LiveView" %></h2>
      <%= live_render(@socket, DemoWeb.WeatherLive, id: :weather) %>
    </section>

    <section class="row">
      <article class="column">
        <h4>LiveView Examples</h4>
        <ul>
          <li><%= live_redirect "Thermostat", to: Routes.live_path(@socket, DemoWeb.ThermostatLive) %></li>
          <li><%= live_redirect "Snake", to: Routes.live_path(@socket, DemoWeb.SnakeLive) %></li>
          <li><%= live_redirect "Search with autocomplete", to: Routes.live_path(@socket, DemoWeb.SearchLive) %></li>
          <li><%= live_redirect "CRUD users with live pagination", to: Routes.user_index_path(@socket, :index) %></li>
          <li><%= live_redirect "Manual infinite scroll with button", to: Routes.user_index_manual_scroll_path(@socket, :index) %></li>
          <li><%= live_redirect "Automatic infinite scroll with JS hook", to: Routes.user_index_auto_scroll_path(@socket, :index) %></li>
          <li><%= live_redirect "Image Editor", to: Routes.live_path(@socket, DemoWeb.ImageLive) %></li>
          <li><%= live_redirect "Clock", to: Routes.live_path(@socket, DemoWeb.ClockLive) %></li>
          <li><%= live_redirect "Pacman", to: Routes.live_path(@socket, DemoWeb.PacmanLive) %></li>
          <li><%= live_redirect "Rainbow", to: Routes.live_path(@socket, DemoWeb.RainbowLive) %></li>
          <li><%= live_redirect "Top", to: Routes.live_path(@socket, DemoWeb.TopLive) %></li>
          <li><%= live_redirect "Presence Example", to: Routes.live_path(@socket, DemoWeb.UserLive.PresenceIndex, "user#{System.unique_integer([:positive])}") %></li>
          <%= if function_exported?(Routes, :live_dashboard_path, 2) do %>
            <li><%= live_redirect "Live Dashboard", to: Routes.live_dashboard_path(@socket, :home) %></li>
          <% end %>
        </ul>
      </article>
    </section>
    """
  end
end

!macro customInstall
  ; Add firewall rule for CarbonBoard web remote (port 9502)
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CarbonBoard Remote"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="CarbonBoard Remote" dir=in action=allow protocol=TCP localport=9502 profile=private'
!macroend

!macro customUnInstall
  ; Remove firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CarbonBoard Remote"'
!macroend

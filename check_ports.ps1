Write-Host "=== COM Ports ==="
[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { Write-Host "  $_" }

Write-Host "`n=== USB Serial Devices ==="
Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'Ports' } | Format-Table Status, FriendlyName -AutoSize

Write-Host "`n=== ESP-related Devices ==="
Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*ESP*' } | Format-Table Status, FriendlyName -AutoSize

Write-Host "`nDone."
Read-Host "Press Enter to continue"
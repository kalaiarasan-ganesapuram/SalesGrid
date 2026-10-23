/**
 * Example trigger for the Sales Grid Log Explorer. Acts only on accounts named
 * "Sales Grid Demo…", so other accounts are not affected.
 */
trigger SalesGridDemoTrigger on Account (before insert, before update, after insert, after update) {
    List<Account> demo = new List<Account>();
    for (Account acc : Trigger.new) {
        if (acc.Name != null && acc.Name.startsWith('Sales Grid Demo')) {
            demo.add(acc);
        }
    }
    if (demo.isEmpty()) {
        return;
    }
    System.debug('SalesGridDemoTrigger ' + Trigger.operationType + ' for ' + demo.size() + ' account(s)');
    if (Trigger.isBefore) {
        SalesGridDemoTriggerHandler.beforeSave(demo);
    } else {
        SalesGridDemoTriggerHandler.afterSave(demo);
    }
}
